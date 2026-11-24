//! Palm mutes and dead notes: GP8-faithful damped ring over written duration (dynamic 3-pole low-pass sweep, unfiltered
//! initial pick transient, low-string 82 Hz resonance, exponential damping), no string-release recording, and dead-note thud
//! below the lowest sampled root. Everything here runs on synthetic recordings, so it needs neither fetched audio nor
//! private scores.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    sync::Arc,
};
use tabplayer_lib::{
    audio::{
        decode::DecodedAudio,
        plan::Articulation,
        renderer::Renderer,
        voices::{
            DEFAULT_PALM_MUTE_STRENGTH, HEAVY_PALM_MUTE_STRENGTH, SampleVoice, VoiceParameters,
        },
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

/// Energy of `x` in frequency band `[lo_hz, hi_hz)` by Hann-windowed DFT at 10 Hz spacing.
fn band_energy(x: &[f32], rate: u32, lo_hz: f64, hi_hz: f64) -> f64 {
    let len = x.len().max(1);
    let mut sum = 0.0;
    let mut hz = lo_hz;
    while hz < hi_hz {
        let (mut s, mut c) = (0.0, 0.0);
        for (n, &v) in x.iter().enumerate() {
            let w = 0.5 - 0.5 * (std::f64::consts::TAU * n as f64 / len as f64).cos();
            let a = std::f64::consts::TAU * hz * n as f64 / rate as f64;
            s += v as f64 * w * a.sin();
            c += v as f64 * w * a.cos();
        }
        sum += s * s + c * c;
        hz += 10.0;
    }
    sum / len as f64
}

/// Written quarter note at 155 BPM (about 387 ms); half note ~774 ms, eighth note ~193 ms.
const MUTE_QUARTER: f64 = 0.35;
const MUTE_HALF: f64 = 0.774;
const MUTE_EIGHTH: f64 = 0.193;
/// 31 ms, a dead note.
const DEAD: f64 = 0.03125;

#[test]
fn muted_and_dead_notes_fire_no_release_recording() {
    // Palm mutes and dead notes only: the loud release recording must change nothing.
    let notes: [Note; 4] = [
        (0.1, MUTE_QUARTER, 26, "muted", 1, None),
        (0.8, DEAD, 26, "dead", 1, None),
        (1.5, MUTE_QUARTER, 40, "muted", 2, None),
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
        // Note: `palm_common`'s synthetic `"stac"` clip is 0.6 s at root E2 (so ~0.40 s at B2) with a fast 0.12 s decay.
        // Verify full renderer behavior past the old 200 ms cutoff AND test sustained GP8-length half/eighth notes directly.
        let half = render(&[(0.1, MUTE_HALF, key, "muted", 1, None)], 1.6, true);
        let frame = |buf: &[f32], from: f64| rms(&buf[at(0.1 + from)..at(0.1 + from + 0.02)]);
        let loudest = (0..25)
            .map(|i| frame(&half, i as f64 * 0.01))
            .fold(0.0f64, f64::max);
        let at_100 = db(frame(&half, 0.1)) - db(loudest);
        let at_220 = db(frame(&half, 0.22)) - db(loudest);
        let at_320 = db(frame(&half, 0.32)) - db(loudest);
        assert!(
            at_100 > -17.0 && at_220 > -36.0,
            "key {key}: half note cut off early (+100ms={at_100:.1}, +220ms={at_220:.1} dB)"
        );
        assert!(
            at_320 < at_100 - 3.0,
            "key {key}: half note did not decay with damping (+100ms={at_100:.1}, +320ms={at_320:.1} dB)"
        );
        let after_half = db(rms(&half[at(0.1 + MUTE_HALF + 0.25)..at(1.55)])) - db(loudest);
        assert!(
            after_half < -45.0,
            "key {key}: half note lingered {after_half:.1} dB after release"
        );

        // With a sustained guitar-length recording (1.8 s), the half note rings with GP8 damping through +400 ms and +550 ms.
        let sustained = pluck(1.8, 0.5);
        let sus_half = voice_output_with(
            &sustained,
            Articulation::Muted,
            key,
            100,
            Some(0),
            DEFAULT_PALM_MUTE_STRENGTH,
            MUTE_HALF,
            1.4,
        );
        let sus_eighth = voice_output_with(
            &sustained,
            Articulation::Muted,
            key,
            100,
            Some(0),
            DEFAULT_PALM_MUTE_STRENGTH,
            MUTE_EIGHTH,
            1.4,
        );
        let vframe = |buf: &[f32], from: f64| rms(&buf[at(from)..at(from + 0.02)]);
        let sus_peak = (0..25)
            .map(|i| vframe(&sus_half, i as f64 * 0.01))
            .fold(0.0f64, f64::max);
        let h400 = db(vframe(&sus_half, 0.40)) - db(sus_peak);
        let e400 = db(vframe(&sus_eighth, 0.40)) - db(sus_peak);
        assert!(
            h400 > -32.0 && h400 > e400 + 15.0,
            "key {key}: sustained half note at +400ms ({h400:.1} dB) vs released eighth ({e400:.1} dB)"
        );
        let after_sus_half = db(rms(&sus_half[at(MUTE_HALF + 0.30)..at(1.35)])) - db(sus_peak);
        assert!(
            after_sus_half < -45.0,
            "key {key}: sustained half note lingered {after_sus_half:.1} dB after release"
        );
    }
}

#[test]
fn striking_the_string_again_cuts_a_ringing_palm_mute_within_a_few_milliseconds() {
    // The same string struck again at 0.22 s while a quarter-note mute is ringing: cut_ring() fades it in 4 ms on every voice
    // (including bass recordings whose normal release is 0.25 s).
    let first: Note = (0.1, 0.5, 33, "muted", 1, None);
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
fn voice_output_with(
    audio: &Arc<DecodedAudio>,
    articulation: Articulation,
    key: u8,
    velocity: u8,
    string_idx: Option<u8>,
    strength: f64,
    release_at: f64,
    seconds: f64,
) -> Vec<f32> {
    let mut voice = SampleVoice::new(audio.clone(), parameters(articulation, key, velocity), RATE)
        .unwrap()
        .with_palm_mute(string_idx, strength);
    (0..at(seconds))
        .map(|n| {
            if n == at(release_at) {
                voice.release();
            }
            voice.next_frame(0.0)[0]
        })
        .collect()
}
fn voice_output(
    audio: &Arc<DecodedAudio>,
    articulation: Articulation,
    key: u8,
    velocity: u8,
    release_at: f64,
    seconds: f64,
) -> Vec<f32> {
    voice_output_with(
        audio,
        articulation,
        key,
        velocity,
        Some(0),
        DEFAULT_PALM_MUTE_STRENGTH,
        release_at,
        seconds,
    )
}

#[test]
fn palm_mute_is_darker_than_open_and_not_far_from_it_in_level_dry() {
    let stac = pluck(0.6, 0.12);
    let open = pluck(1.2, 0.5);
    let lead_root = tabplayer_lib::audio::voices::lead_in_frames(&stac) / RATE as f64;
    for (key, str_idx) in [(26u8, 0u8), (33, 1), (39, 0), (40, 0), (45, 1), (52, 2)] {
        let muted = voice_output_with(
            &stac,
            Articulation::Muted,
            key,
            100,
            Some(str_idx),
            DEFAULT_PALM_MUTE_STRENGTH,
            MUTE_QUARTER,
            0.4,
        );
        let picked = voice_output(&open, Articulation::Picked, key, 100, MUTE_QUARTER, 0.4);
        let level = db(rms(&muted[..at(0.25)])) - db(rms(&picked[..at(0.25)]));
        assert!(
            (-9.5..=0.5).contains(&level),
            "key {key} str {str_idx}: palm mute {level:.1} dB against the open note"
        );
        // After the 3.6 ms unfiltered GP8 pick transient, the 3-pole low-pass sweep leaves the body far darker than an open note.
        let lead_s = lead_root / 2f64.powf((key as f64 - ROOT as f64) / 12.0);
        let body_start = at(lead_s + 0.015);
        let split = 440.0 * 2f64.powf((key as f64 - 69.0) / 12.0) * 6.0;
        let darker = bright_ratio(&muted[body_start..at(0.25)], split)
            / bright_ratio(&picked[body_start..at(0.25)], split);
        assert!(
            darker < 0.25,
            "key {key}: body bright-to-low energy {darker:.3} times the open note's"
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
    // Light is a staccato note, Normal a palm mute at default strength 0.3, Heavy a stronger 0.65 palm mute at 0.8 velocity.
    let stac = pluck(0.8, 0.16);
    let light = voice_output_with(
        &stac,
        Articulation::Staccato,
        33,
        100,
        Some(1),
        DEFAULT_PALM_MUTE_STRENGTH,
        MUTE_QUARTER,
        0.5,
    );
    let normal = voice_output_with(
        &stac,
        Articulation::Muted,
        33,
        100,
        Some(1),
        DEFAULT_PALM_MUTE_STRENGTH,
        MUTE_QUARTER,
        0.5,
    );
    let heavy = voice_output_with(
        &stac,
        Articulation::Muted,
        33,
        80,
        Some(1),
        HEAVY_PALM_MUTE_STRENGTH,
        MUTE_QUARTER,
        0.5,
    );
    let level = |x: &[f32]| db(rms(&x[..at(0.30)]));
    assert!(
        level(&normal) - level(&heavy) > 2.0,
        "heavy ({:.1} dB) is not softer than normal ({:.1} dB)",
        level(&heavy),
        level(&normal)
    );
    let bright = |x: &[f32]| bright_ratio(&x[at(0.04)..at(0.30)], 400.0);
    assert!(
        bright(&light) > bright(&normal) * 3.0,
        "light is not brighter than normal"
    );
    let tail = |x: &[f32]| db(rms(&x[at(0.15)..at(0.35)])) - level(x);
    assert!(
        tail(&heavy) < tail(&normal) - 1.5,
        "heavy does not damp faster than normal (normal {:.1}, heavy {:.1})",
        tail(&normal),
        tail(&heavy)
    );
    assert!(
        tail(&normal) > tail(&light) + 3.0,
        "normal ({:.1}) does not ring longer than light ({:.1})",
        tail(&normal),
        tail(&light)
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
        (0.0, MUTE_EIGHTH, 26, "muted", 1, None),
        (0.125, MUTE_EIGHTH, 33, "muted", 1, None),
        (0.25, DEAD, 26, "dead", 2, None),
        (0.375, MUTE_QUARTER, 40, "muted", 1, None),
        (0.5, 0.2, 45, "picked", 3, None),
        (0.8, MUTE_QUARTER, 38, "muted", 2, None),
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
    let open: [Note; 1] = [(0.1, MUTE_QUARTER, 33, "picked", 1, None)];
    let muted: [Note; 1] = [(0.1, MUTE_QUARTER, 33, "muted", 1, None)];
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
    assert!(
        muted_rms - open_rms < 0.0 && muted_rms - open_rms > -8.0,
        "muted {muted_rms:.2} vs open {open_rms:.2}"
    );
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
            note("muted", MUTE_EIGHTH),
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
            (start, MUTE_QUARTER, key, "muted", i as u32 + 1, None),
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

#[test]
fn low_strings_have_gp8_palm_mute_chug_resonance() {
    let open = pluck(1.2, 0.5);
    for key in [26u8, 40] {
        let low_band = |str_idx: u8| {
            let out = voice_output_with(
                &open,
                Articulation::Muted,
                key,
                100,
                Some(str_idx),
                DEFAULT_PALM_MUTE_STRENGTH,
                0.5,
                0.55,
            );
            band_energy(&out[at(0.10)..at(0.25)], RATE, 60.0, 110.0)
        };
        let s0 = low_band(0);
        let s1 = low_band(1);
        let s2 = low_band(2);
        assert!(
            s0 > s1 * 1.5 && s1 > s2 * 1.3,
            "key {key}: expected 82 Hz chug resonance str0 ({s0:.3e}) > str1 ({s1:.3e}) > str2 ({s2:.3e})"
        );
    }
}

#[test]
fn palm_mute_preserves_initial_pick_transient() {
    let open = pluck(1.2, 0.5);
    let muted = voice_output_with(
        &open,
        Articulation::Muted,
        40,
        100,
        Some(0),
        DEFAULT_PALM_MUTE_STRENGTH,
        0.35,
        0.4,
    );
    let picked = voice_output(&open, Articulation::Picked, 40, 100, 0.35, 0.4);
    // In `pluck()`, the pick and noise burst open at 20 ms (`lead_seconds` = 19 ms at root 40); the first 3.6 ms after pick pass unfiltered.
    let pick_win = at(0.020)..at(0.0235);
    let body_win = at(0.080)..at(0.220);
    let pick_high_m = band_energy(&muted[pick_win.clone()], RATE, 1000.0, 8000.0);
    let pick_high_p = band_energy(&picked[pick_win], RATE, 1000.0, 8000.0);
    assert!(
        pick_high_m > pick_high_p * 0.5,
        "initial pick transient was muffled: muted {pick_high_m:.3e} vs picked {pick_high_p:.3e}"
    );
    let body_high_m = band_energy(&muted[body_win.clone()], RATE, 1000.0, 8000.0);
    let body_high_p = band_energy(&picked[body_win], RATE, 1000.0, 8000.0);
    assert!(
        body_high_m < body_high_p * 0.05,
        "body high frequencies were not rolled off: muted {body_high_m:.3e} vs picked {body_high_p:.3e}"
    );
}

#[test]
fn palm_mute_behavior_is_sample_rate_independent() {
    let open = pluck(1.2, 0.5);
    for key in [26u8, 40] {
        let render_at = |rate: u32| -> [f64; 3] {
            let mut voice = SampleVoice::new(
                open.clone(),
                parameters(Articulation::Muted, key, 100),
                rate,
            )
            .unwrap()
            .with_palm_mute(Some(0), DEFAULT_PALM_MUTE_STRENGTH);
            let total = (0.55 * rate as f64) as usize;
            let samples: Vec<f32> = (0..total).map(|_| voice.next_frame(0.0)[0]).collect();
            let slice_db = |a: f64, b: f64| {
                db(rms(
                    &samples[(a * rate as f64) as usize..(b * rate as f64) as usize]
                ))
            };
            [
                slice_db(0.0, 0.10),
                slice_db(0.10, 0.25),
                slice_db(0.25, 0.50),
            ]
        };
        let base = render_at(44_100);
        for rate in [48_000u32, 96_000] {
            let got = render_at(rate);
            for (w, (g, b)) in got.iter().zip(base).enumerate() {
                assert!(
                    (g - b).abs() < 1.5,
                    "key {key} rate {rate} window {w}: {g:.2} dB vs 44.1 kHz {b:.2} dB"
                );
            }
        }
    }
}

#[test]
fn six_string_palm_muted_chord_stays_off_the_limiter() {
    for keys in [[40u8, 45, 50, 55, 59, 64], [26, 33, 38, 43, 47, 52]] {
        let notes: Vec<Note> = keys
            .iter()
            .enumerate()
            .map(|(i, &k)| (0.1, 0.4, k, "muted", i as u32 + 1, None))
            .collect();
        let chord = render(&notes, 0.8, false);
        let pk = peak(&chord);
        assert!(
            pk > 0.02 && pk < 0.9,
            "6-string palm-muted chord peak {pk:.3} out of safe dry headroom"
        );
    }
}
