//! Palm mutes and dead notes (THE-214): no string-release recording, a damped ring-out instead of an 83 ms cut, a darker
//! tone, and an audible thud below the lowest sampled root. Everything here runs on synthetic recordings, so it needs
//! neither the fetched audio nor the owner's scores.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::HashMap,
    io::Cursor,
    sync::Arc,
};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        plan::{Articulation, PlaybackPlan},
        renderer::Renderer,
        resources::{AudioResources, Instrument, InstrumentManifest, Region},
        voices::{SampleVoice, VoiceParameters},
    },
    settings::DocumentSettings,
};

mod palm_common;
use palm_common::*;

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

fn db(v: f64) -> f64 {
    20.0 * v.max(1e-12).log10()
}
fn rms(x: &[f32]) -> f64 {
    (x.iter().map(|&v| v as f64 * v as f64).sum::<f64>() / x.len().max(1) as f64).sqrt()
}
fn peak(x: &[f32]) -> f64 {
    x.iter().fold(0.0f64, |m, &v| m.max(v.abs() as f64))
}
fn at(seconds: f64) -> usize {
    (seconds * RATE as f64) as usize
}
/// Energy of `x` at and above `split` Hz over the energy below it, by a DFT at 20 Hz spacing up to 8 kHz.
fn bright_ratio(x: &[f32], split: f64) -> f64 {
    let (mut low, mut high) = (0.0, 0.0);
    let mut hz = 40.0;
    while hz < 8000.0 {
        let (mut s, mut c) = (0.0, 0.0);
        for (n, &v) in x.iter().enumerate() {
            let a = std::f64::consts::TAU * hz * n as f64 / RATE as f64;
            s += v as f64 * a.sin();
            c += v as f64 * a.cos();
        }
        if hz < split {
            low += s * s + c * c;
        } else {
            high += s * s + c * c;
        }
        hz += 20.0;
    }
    high / low.max(1e-30)
}

/// 83 ms, the length alphaTab gives every palm-muted note.
const MUTE: f64 = 0.0833;
/// 31 ms, a dead note.
const DEAD: f64 = 0.03125;

#[test]
fn muted_and_dead_notes_fire_no_release_recording() {
    // Palm mutes and dead notes only: the loud release recording must change nothing.
    let notes: [Note; 4] = [
        (0.1, MUTE, 26, "muted", 1, None),
        (0.8, DEAD, 26, "dead", 1, None),
        (1.5, MUTE, 40, "muted", 2, None),
        (2.2, DEAD, 45, "dead", 2, None),
    ];
    let with = render(&notes, 3.0, true);
    let without = render(&notes, 3.0, false);
    assert_eq!(
        with, without,
        "a muted or dead note triggered the release recording"
    );
    assert!(peak(&with) > 0.01, "the notes were silent");
    // An open note still releases: the recording is there and the control note sounds it.
    let open: [Note; 1] = [(0.1, 0.2, 26, "picked", 1, None)];
    assert_ne!(render(&open, 1.5, true), render(&open, 1.5, false));
}

#[test]
fn palm_mute_rings_like_a_damped_string_and_is_gone_soon_after() {
    for key in [26u8, 33, 40, 47] {
        let x = render(&[(0.1, MUTE, key, "muted", 1, None)], 1.5, true);
        let frame = |from: f64| rms(&x[at(0.1 + from)..at(0.1 + from + 0.01)]);
        let loudest = (0..30)
            .map(|i| frame(i as f64 * 0.01))
            .fold(0.0f64, f64::max);
        // About 100 ms after the strike the string is still ringing, far above an 83 ms cut (about -28 dB there) but well down.
        let level = db(frame(0.1)) - db(loudest);
        assert!(
            (-17.0..=-3.0).contains(&level),
            "key {key}: {level:.1} dB at +100 ms"
        );
        // Silent by 400 ms: the ring is bounded at 200 ms plus its release.
        let late = db(rms(&x[at(0.1 + 0.4)..at(0.1 + 1.2)])) - db(loudest);
        assert!(late < -50.0, "key {key}: {late:.1} dB after 400 ms");
    }
}

#[test]
fn striking_the_string_again_cuts_a_ringing_palm_mute_within_a_few_milliseconds() {
    // The same string struck again at 0.22 s: the first mute's ring is gone by 0.24 s on every voice (the bass recordings release over a quarter
    // of a second, so a cut that used the recording's release would still be ringing). The first note alone is a mute ringing until about 0.34 s.
    let first: Note = (0.1, MUTE, 33, "muted", 1, None);
    let strike: Note = (0.22, 0.05, 33, "dead", 1, None);
    let on_another_string: Note = (0.22, 0.05, 33, "dead", 2, None);
    for program in [30u8, 24, 33, 34] {
        let cut = render_program(program, &[first, strike], 1.0, false);
        let alone = render_program(program, &[strike], 1.0, false);
        let rings_on = render_program(program, &[first, on_another_string], 1.0, false);
        let window = at(0.24)..at(0.29);
        let diff = |a: &[f32], b: &[f32]| {
            rms(&a[window.clone()]
                .iter()
                .zip(&b[window.clone()])
                .map(|(x, y)| x - y)
                .collect::<Vec<_>>())
        };
        let ring = diff(&rings_on, &alone);
        let left_after_cut = diff(&cut, &alone);
        assert!(
            ring > 1e-4,
            "program {program}: the mute should ring on another string ({ring})"
        );
        assert!(
            left_after_cut < ring * 0.02,
            "program {program}: {left_after_cut} of {ring} left after the cut"
        );
    }
}

fn parameters(articulation: Articulation, key: u8, velocity: u8) -> VoiceParameters {
    VoiceParameters {
        root_key: ROOT,
        key,
        velocity,
        articulation,
        attack_seconds: 0.01,
        release_seconds: 0.05,
        gain_db: 0.0,
        loop_start: None,
        loop_end: None,
        pitch_keytrack: 100.0,
        velocity_gain_high: 127,
        tuning_cents: 0.0,
        is_recorded_harmonic: false,
    }
}
fn voice_output(
    audio: &Arc<DecodedAudio>,
    articulation: Articulation,
    key: u8,
    velocity: u8,
    release_at: f64,
    seconds: f64,
) -> Vec<f32> {
    let mut voice =
        SampleVoice::new(audio.clone(), parameters(articulation, key, velocity), RATE).unwrap();
    (0..at(seconds))
        .map(|n| {
            if n == at(release_at) {
                voice.release();
            }
            voice.next_frame(0.0)[0]
        })
        .collect()
}

#[test]
fn palm_mute_is_darker_than_open_and_not_far_from_it_in_level_dry() {
    let stac = pluck(0.6, 0.12);
    let open = pluck(1.2, 0.5);
    // The owner's low range and the standard-tuned range from E2 up. Measured -5.1 dB at D1 falling to -7.3 dB at E3 on this synthetic pair; the
    // window is that range plus about 1.5 dB. The old gain 0.8, 1 kHz low-pass and cut at 83 ms gave -13.5 dB at D1 and would fail it.
    for key in [26u8, 33, 39, 40, 45, 52] {
        let muted = voice_output(&stac, Articulation::Muted, key, 100, MUTE, 0.4);
        let picked = voice_output(&open, Articulation::Picked, key, 100, 0.222, 0.4);
        let level = db(rms(&muted[..at(0.25)])) - db(rms(&picked[..at(0.25)]));
        assert!(
            (-8.5..=-4.0).contains(&level),
            "key {key}: palm mute {level:.1} dB against the open note"
        );
        let split = 440.0 * 2f64.powf((key as f64 - 69.0) / 12.0) * 6.0;
        let darker =
            bright_ratio(&muted[..at(0.25)], split) / bright_ratio(&picked[..at(0.25)], split);
        assert!(
            darker < 0.5,
            "key {key}: bright-to-low energy {darker:.2} times the open note's"
        );
    }
}

#[test]
fn dead_notes_are_a_thud_that_is_heard_below_the_lowest_sampled_root() {
    let thud = pluck(0.3, 0.05);
    let open = pluck(1.2, 0.5);
    for key in [26u8, 29, 33, 36, 39, 40, 52] {
        let dead = voice_output(&thud, Articulation::Dead, key, 100, DEAD, 0.4);
        let picked = voice_output(&open, Articulation::Picked, key, 100, 0.222, 0.4);
        let strike = db(peak(&dead[..at(0.08)])) - db(peak(&picked[..at(0.08)]));
        assert!(
            strike > -14.0,
            "key {key}: thud {strike:.1} dB against the open note"
        );
        // Still short: gone within 150 ms.
        assert!(
            db(rms(&dead[at(0.15)..at(0.3)])) - db(peak(&dead)) < -45.0,
            "key {key}"
        );
    }
}

#[test]
fn palm_mute_light_normal_and_heavy_stay_distinct() {
    // Light is a staccato note, Normal a palm mute, Heavy the palm mute at 0.8 of the velocity (src/audio/interpretation.ts).
    let stac = pluck(0.6, 0.12);
    let light = voice_output(&stac, Articulation::Staccato, 33, 100, MUTE, 0.4);
    let normal = voice_output(&stac, Articulation::Muted, 33, 100, MUTE, 0.4);
    let heavy = voice_output(&stac, Articulation::Muted, 33, 80, MUTE, 0.4);
    let level = |x: &[f32]| db(rms(&x[..at(0.25)]));
    assert!(
        (level(&normal) - level(&heavy)).abs() > 1.5,
        "heavy is not softer than normal"
    );
    let bright = |x: &[f32]| bright_ratio(&x[..at(0.25)], 400.0);
    assert!(
        bright(&light) > bright(&normal) * 3.0,
        "light is not brighter than normal"
    );
    let tail = |x: &[f32]| db(rms(&x[at(0.12)..at(0.25)])) - level(x);
    assert!(
        tail(&normal) > tail(&light) + 3.0,
        "normal does not ring longer than light"
    );
}

#[test]
fn ring_cut_touches_only_a_ringing_palm_mute() {
    let stac = pluck(0.6, 0.12);
    let mut muted =
        SampleVoice::new(stac.clone(), parameters(Articulation::Muted, 33, 100), RATE).unwrap();
    for n in 0..at(0.06) {
        if n == at(0.04) {
            muted.release();
        }
        muted.next_frame(0.0);
    }
    assert!(
        muted.cut_ring(),
        "a mute released early should still be ringing"
    );
    let after: Vec<f32> = (0..at(0.3)).map(|_| muted.next_frame(0.0)[0]).collect();
    assert!(
        rms(&after[at(0.1)..]) < 1e-5,
        "the cut ring was not silenced"
    );
    let mut open = SampleVoice::new(
        pluck(1.2, 0.5),
        parameters(Articulation::Picked, 33, 100),
        RATE,
    )
    .unwrap();
    open.next_frame(0.0);
    assert!(!open.cut_ring());
}

#[test]
fn rendering_muted_and_dead_notes_touches_no_heap() {
    let notes: [Note; 6] = [
        (0.0, MUTE, 26, "muted", 1, None),
        (0.125, MUTE, 33, "muted", 1, None),
        (0.25, DEAD, 26, "dead", 2, None),
        (0.375, MUTE, 40, "muted", 1, None),
        (0.5, 0.2, 45, "picked", 3, None),
        (0.8, MUTE, 38, "muted", 2, None),
    ];
    let mut renderer = Renderer::new(
        plan(&notes, 2.0, 30),
        resources(true),
        DocumentSettings::default(),
        RATE,
    )
    .unwrap();
    let mut block = [[0.0f32; 2]; 512];
    HEAP_OPERATIONS.with(|n| n.set(0));
    COUNT_HEAP.with(|f| f.set(true));
    for _ in 0..180 {
        renderer.render_into(&mut block);
    }
    COUNT_HEAP.with(|f| f.set(false));
    assert_eq!(HEAP_OPERATIONS.with(Cell::get), 0);
}

#[test]
fn palm_mutes_and_dead_notes_keep_their_own_balance_on_each_voice() {
    // The same recordings under each voice: only the technique trim differs. Black guitar (program 30) is the reference;
    // the acoustic and the two basses sit lower so they stay near the open-note balance they had before THE-214.
    let open: [Note; 1] = [(0.1, 0.2, 33, "picked", 1, None)];
    let muted: [Note; 1] = [(0.1, MUTE, 33, "muted", 1, None)];
    let dead: [Note; 1] = [(0.1, DEAD, 33, "dead", 1, None)];
    // The peak, which the voices' different release times (the bass recordings release over a quarter of a second) do not touch.
    let level = |program: u8, notes: &[Note]| db(peak(&render_program(program, notes, 1.0, false)));
    let reference = (level(30, &open), level(30, &muted), level(30, &dead));
    for (program, name, mute_trim, dead_trim) in [
        (24, "green-guitar", -3.0, -6.0),
        (33, "babyblue-bass", -6.2, -5.0),
        (34, "darkblack-bass", -3.0, -5.0),
    ] {
        assert!(
            (level(program, &open) - reference.0).abs() < 1e-6,
            "{name}: open notes must not change"
        );
        let mute = level(program, &muted) - reference.1;
        let thud = level(program, &dead) - reference.2;
        assert!(
            (mute - mute_trim).abs() < 0.05,
            "{name}: palm mute {mute:.2} dB"
        );
        assert!(
            (thud - dead_trim).abs() < 0.05,
            "{name}: dead note {thud:.2} dB"
        );
    }
    // On the black guitar a palm mute is not louder than an open note dry, and a dead note is well under it.
    let energy = |notes: &[Note]| db(rms(&render_program(30, notes, 1.0, false)));
    let (open_rms, muted_rms, dead_rms) = (energy(&open), energy(&muted), energy(&dead));
    assert!(muted_rms - open_rms < 0.0 && muted_rms - open_rms > -6.0);
    assert!(dead_rms < open_rms - 3.0);
}

fn onset(x: &[f32]) -> f64 {
    // The first frame at 2% of the loudest: the recording's near-silent lead-in lies below it and the pick above.
    let top = x.iter().fold(0.0f32, |m, v| m.max(v.abs()));
    x.iter().position(|v| v.abs() >= 0.02 * top).unwrap() as f64 * 1000.0 / RATE as f64
}

#[test]
fn muted_dead_and_open_notes_sound_their_pick_at_the_same_time() {
    // Every recording opens with the same lead-in, so a note's pick lands 20 ms after its start at E2 and 45 ms at D1 for muted, dead
    // and open notes alike (the timing `develop` had for all three): a palm mute chug, a dead note and an open accent at one tick must
    // not flam against each other, and neither may a bass doubling them.
    for (key, expected_ms) in [(40u8, 20.0), (26, 20.0 / 2f64.powf(-14.0 / 12.0))] {
        let note = |articulation: &'static str, length: f64| -> f64 {
            onset(&render(
                &[(0.1, length, key, articulation, 1, None)],
                0.6,
                false,
            )) - 100.0
        };
        let (open, muted, dead) = (
            note("picked", 0.222),
            note("muted", MUTE),
            note("dead", DEAD),
        );
        for (name, got) in [("open", open), ("muted", muted), ("dead", dead)] {
            assert!(
                (got - expected_ms).abs() < 1.0,
                "key {key}: {name} pick at {got:.2} ms, expected {expected_ms:.2}"
            );
        }
        assert!((muted - open).abs() <= 1.0 && (dead - open).abs() <= 1.0);
    }
}

fn peak_of(x: &[f32], from: f64, to: f64) -> f64 {
    peak(&x[at(from)..at(to)])
}

#[test]
fn a_dead_note_does_not_strike_louder_than_an_open_note() {
    // Peak within 150 ms of the strike (a 31 ms thud against an open note's attack), keys 26 to 52, margin 3 dB under the open note.
    for key in (26u8..=52).step_by(2) {
        let dead = render(&[(0.1, DEAD, key, "dead", 1, None)], 0.6, false);
        let open = render(&[(0.1, 0.222, key, "picked", 1, None)], 0.6, false);
        let margin = db(peak_of(&dead, 0.1, 0.25)) - db(peak_of(&open, 0.1, 0.25));
        assert!(
            margin < -3.0,
            "key {key}: dead note {margin:.1} dB against the open note's peak"
        );
    }
}

#[test]
fn a_dead_chord_is_not_louder_than_an_open_chord_and_stays_off_the_limiter() {
    // Six strings struck together, standard tuning and the owner's low tuning, dry: the master limiter soft-clips above 0.9.
    for keys in [[40u8, 45, 50, 55, 59, 64], [26, 33, 38, 43, 47, 52]] {
        let chord = |articulation: &'static str, length: f64| {
            let notes: Vec<Note> = keys
                .iter()
                .enumerate()
                .map(|(i, &k)| (0.1, length, k, articulation, i as u32 + 1, None))
                .collect();
            render(&notes, 0.8, false)
        };
        let (open, dead) = (chord("picked", 0.3), chord("dead", DEAD));
        let (open_peak, dead_peak) = (peak(&open), peak(&dead));
        assert!(open_peak < 0.9, "open chord {open_peak:.3}");
        assert!(
            dead_peak < 0.9 && dead_peak <= open_peak * 0.71,
            "dead chord {dead_peak:.3} against open {open_peak:.3}"
        );
    }
}

fn lead(audio: &Arc<DecodedAudio>) -> f64 {
    tabplayer_lib::audio::voices::lead_in_frames(audio)
}
fn prepared(articulation: Articulation, key: u8, trims: (f64, f64)) -> SampleVoice {
    let audio = pluck(0.6, 0.12);
    SampleVoice::prepared(
        audio.clone(),
        parameters(articulation, key, 100),
        RATE,
        lead(&audio),
        trims,
    )
    .unwrap()
}
fn run(voice: &mut SampleVoice, frames: usize) -> Vec<f32> {
    (0..frames).map(|_| voice.next_frame(0.0)[0]).collect()
}

#[test]
fn a_join_takes_the_trim_of_the_technique_it_sounds_in_both_directions() {
    // A slide or hammer-on from a palm mute (and one into it) must not carry the first note's trim: the babyblue-bass trims are -6.2 dB / -3 dB.
    let trims = (-6.2, -3.0);
    for (from, to) in [
        (Articulation::Muted, Articulation::Picked),
        (Articulation::Dead, Articulation::Legato),
    ] {
        let (mut trimmed, mut plain) = (prepared(from, 33, trims), prepared(from, 33, (0.0, 0.0)));
        run(&mut trimmed, 2000);
        run(&mut plain, 2000);
        trimmed.transition(35, to);
        plain.transition(35, to);
        let (a, b) = (run(&mut trimmed, 9600), run(&mut plain, 9600));
        assert_eq!(
            a[4800..],
            b[4800..],
            "{from:?} to {to:?}: the trim leaked into the joined note"
        );
    }
    for (from, to, trim) in [
        (Articulation::Picked, Articulation::Muted, -6.2),
        (Articulation::Legato, Articulation::Dead, -3.0),
    ] {
        let (mut trimmed, mut plain) = (prepared(from, 33, trims), prepared(from, 33, (0.0, 0.0)));
        run(&mut trimmed, 2000);
        run(&mut plain, 2000);
        trimmed.transition(35, to);
        plain.transition(35, to);
        let (a, b) = (run(&mut trimmed, 9600), run(&mut plain, 9600));
        let got = db(rms(&a[4800..6000])) - db(rms(&b[4800..6000]));
        assert!(
            (got - trim).abs() < 0.1,
            "{from:?} to {to:?}: trim {got:.2} dB, wanted {trim}"
        );
    }
}

#[test]
fn a_join_between_a_muted_and_an_open_note_glides_the_low_pass() {
    let ms = |ms: f64| (ms * RATE as f64 / 1000.0) as usize;
    let mut voice = prepared(Articulation::Muted, 33, (0.0, 0.0));
    run(&mut voice, 3000);
    let before = voice.filter_cutoff_hz();
    assert!(before < 300.0, "{before}");
    voice.transition(35, Articulation::Picked);
    let mut last = before;
    let mut at_1ms = 0.0;
    for n in 0..ms(30.0) {
        voice.next_frame(0.0);
        let now = voice.filter_cutoff_hz();
        assert!(now >= last - 1e-9, "the low-pass must only open");
        last = now;
        if n == ms(1.0) {
            at_1ms = now;
        }
    }
    assert!(
        at_1ms < 6000.0,
        "a muted note's 140 to 330 Hz low-pass jumped to {at_1ms} Hz within 1 ms"
    );
    assert!(
        last > 15_000.0,
        "the low-pass should have opened by 30 ms, at {last}"
    );
    // The other way: an open note joined into a palm mute closes over a few milliseconds.
    let mut voice = prepared(Articulation::Picked, 33, (0.0, 0.0));
    run(&mut voice, 3000);
    voice.transition(33, Articulation::Muted);
    voice.next_frame(0.0);
    assert!(voice.filter_cutoff_hz() > 14_000.0);
    run(&mut voice, ms(30.0));
    assert!(voice.filter_cutoff_hz() < 400.0);
    // A join between two open techniques is not smoothed (bit-identity with develop).
    let mut open = prepared(Articulation::Picked, 33, (0.0, 0.0));
    run(&mut open, 100);
    open.transition(35, Articulation::Legato);
    open.next_frame(0.0);
    assert_eq!(open.filter_cutoff_hz(), 7000.0);
}

#[test]
fn starting_and_seeking_muted_and_dead_notes_measures_no_lead_in_on_the_audio_thread() {
    let mut notes: Vec<Note> = [
        (0.0, 26u8),
        (0.0, 33),
        (0.0, 38),
        (0.0, 43),
        (0.0, 47),
        (0.0, 52),
    ]
    .iter()
    .enumerate()
    .flat_map(|(i, &(start, key))| {
        [
            (start, MUTE, key, "muted", i as u32 + 1, None),
            (start + 0.5, DEAD, key, "dead", i as u32 + 1, None),
        ]
    })
    .collect();
    notes.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut renderer = Renderer::new(
        plan(&notes, 2.0, 30),
        resources(true),
        DocumentSettings::default(),
        RATE,
    )
    .unwrap();
    let measured = tabplayer_lib::audio::voices::lead_in_scans();
    let mut block = [[0.0f32; 2]; 512];
    for _ in 0..40 {
        renderer.render_into(&mut block);
    }
    renderer.seek_tick(0.25 * 1920.0);
    for _ in 0..40 {
        renderer.render_into(&mut block);
    }
    assert!(block.iter().any(|f| f[0] != 0.0));
    assert_eq!(
        tabplayer_lib::audio::voices::lead_in_scans(),
        measured,
        "a lead-in was measured during playback"
    );
}

#[test]
fn back_to_back_palm_mutes_do_not_ring_under_the_next_note() {
    // alphaTab ends a palm mute at 83 ms or at the beat's end, whichever is first, so in a fast run a mute ends exactly where the next note
    // on the string starts: 16th triplets at 120 BPM, 16ths at 180, 32nds at 90 (83.3 ms) and 16ths at 200 BPM (75 ms). The old mute must
    // be gone a few ms after the next note starts, not ring about 200 ms under it.
    let gaps = [
        60.0 / 120.0 / 6.0,
        60.0 / 180.0 / 4.0,
        60.0 / 90.0 / 8.0,
        60.0 / 200.0 / 4.0,
    ];
    for program in [30u8, 34] {
        for key in [26u8, 40] {
            for gap in gaps {
                let t1 = 0.1 + gap;
                let first: Note = (0.1, gap, key, "muted", 1, None);
                let second: Note = (t1, gap, key, "muted", 1, None);
                let both = render_program(program, &[first, second], 1.0, true);
                let alone = render_program(program, &[second], 1.0, true);
                let first_alone: Vec<f32> = both.iter().zip(&alone).map(|(a, b)| a - b).collect();
                let before = rms(&first_alone[at(t1 - 0.04)..at(t1)]);
                let after = rms(&first_alone[at(t1 + 0.010)..at(t1 + 0.060)]);
                assert!(
                    before > 1e-4,
                    "program {program} key {key}: the first mute should sound"
                );
                assert!(
                    after < before * 0.06,
                    "program {program} key {key} gap {:.1} ms: the first mute still rings after the second starts ({:.1} dB)",
                    gap * 1000.0,
                    db(after) - db(before)
                );
            }
        }
    }
}

fn flat(seconds: f64) -> Arc<DecodedAudio> {
    Arc::new(DecodedAudio {
        sample_rate: 48_000,
        channels: 2,
        frames: Arc::new(vec![[0.5, 0.5]; (seconds * 48_000.0) as usize]),
    })
}

#[test]
fn the_dead_note_gain_ramps_across_the_root_instead_of_stepping() {
    // A pitch-independent recording (a constant), so only the gain shows. Roots of the lowest recording of the guitars (E2), the dark bass
    // (B1) and the baby-blue bass (E1): neighbouring keys on both sides of the root differ by well under 1.5 dB, and the gain reaches its
    // low value 14 semitones under the root.
    let audio = flat(0.5);
    for root in [40u8, 35, 28] {
        let level = |key: u8| {
            let mut p = parameters(Articulation::Dead, key, 100);
            p.root_key = root;
            let mut voice = SampleVoice::new(audio.clone(), p, RATE).unwrap();
            run(&mut voice, at(0.012)).last().copied().unwrap() as f64
        };
        for key in root.saturating_sub(16)..root + 4 {
            let step = (db(level(key + 1)) - db(level(key))).abs();
            assert!(
                step < 1.0,
                "root {root}: {step:.2} dB between keys {key} and {}",
                key + 1
            );
        }
        let total = db(level(root)) - db(level(root - 14));
        assert!(
            (total - 8.5).abs() < 0.5,
            "root {root}: {total:.2} dB over 14 semitones"
        );
        assert!(
            (db(level(root - 20)) - db(level(root - 14))).abs() < 1e-6,
            "no further fall below the ramp"
        );
    }
}

#[test]
fn a_dead_note_stays_under_an_open_note_through_a_compressed_clean_chain_too() {
    // The factory funk-clean chain (a compressor in front of a clean amp) lifted a pitched-down thud: with a dead gain of 2.0 at D1 the dead
    // note's peak came out 8.7 dB above the open note's through it. Peak within 150 ms, keys 26 to 52, at least 3 dB under.
    for program in [30u8, 34] {
        for key in (26u8..=52).step_by(2) {
            let dead = render_chain(
                program,
                &[(0.1, DEAD, key, "dead", 1, None)],
                0.6,
                false,
                Some(clean_compressed()),
            );
            let open = render_chain(
                program,
                &[(0.1, 0.222, key, "picked", 1, None)],
                0.6,
                false,
                Some(clean_compressed()),
            );
            let margin = db(peak_of(&dead, 0.1, 0.25)) - db(peak_of(&open, 0.1, 0.25));
            assert!(
                margin < -3.0,
                "program {program} key {key}: dead note {margin:.1} dB against the open note, clean chain"
            );
        }
    }
}

#[test]
fn joins_glide_the_gain_and_the_decay_not_just_the_low_pass() {
    // A constant recording, so the output is gain alone. A palm mute that has decayed to about half, joined into an open note, must not
    // jump to full level within one frame; it glides over a few ms. And a dead-to-dead join across the root glides too.
    let audio = flat(1.0);
    let make = |articulation, key: u8| {
        let mut p = parameters(articulation, key, 100);
        p.attack_seconds = 0.0;
        SampleVoice::new(audio.clone(), p, RATE).unwrap()
    };
    let mut voice = make(Articulation::Muted, 33);
    let before = *run(&mut voice, at(0.2)).last().unwrap();
    voice.transition(33, Articulation::Picked);
    let after = run(&mut voice, at(0.05));
    assert!(
        before > 0.05 && after[0] < before * 1.1,
        "a jump from {before} to {} in one frame",
        after[0]
    );
    assert!(
        *after.last().unwrap() > before * 1.5,
        "it should settle at the open note's level"
    );
    let steps = after
        .windows(2)
        .map(|w| (w[1] - w[0]).abs())
        .fold(0.0f32, f32::max);
    assert!(
        steps < before * 0.1,
        "largest frame-to-frame step {steps} against a level of {before}"
    );

    let mut dead = make(Articulation::Dead, 41);
    let level = *run(&mut dead, at(0.001)).last().unwrap();
    dead.transition(34, Articulation::Dead);
    let next = run(&mut dead, 2);
    assert!(
        (next[0] / level - 1.0).abs() < 0.2,
        "{} against {level}: a dead-to-dead join across the root jumped",
        next[0]
    );
}
