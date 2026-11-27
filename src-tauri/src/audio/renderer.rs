//! Shared device/offline renderer. Buffers and sample mappings are prepared off the audio thread.
use super::{
    backing::{BackingMap, BackingVoice},
    compensation::{Compensation, compensation_capacity},
    decode::DecodedAudio,
    drum_map::{self, DrumMap},
    dsp::{FrameContext, FxSettings, MAX_TRACK_DELAY_SECONDS, TrackDsp},
    instrument::NoteMap,
    master::MasterBus,
    midi_out::MidiTap,
    plan::{Articulation, PlanMidiEvent, PlanNote, PlaybackPlan, Timeline},
    plugin_insert::{InsertError, PluginInsert},
    practice::{
        AuthoredTempos, ClickVoice, MetronomeSettings, PracticeRefusal, PulsePosition, RenderTempo,
    },
    resources::{AudioResources, Region},
    voices::{
        DEFAULT_PALM_MUTE_STRENGTH, HEAVY_PALM_MUTE_STRENGTH, SampleVoice, VoiceParameters,
        articulation_name, drum_kit_for_track, effective_note_program, is_drum_instrument,
        legacy_automatic_voice_id, pitch_at, resolve_voice_id, select_region,
        select_region_by_name, start_program, track_locked, with_drum_kits,
        with_locked_articulations,
    },
};
use crate::settings::{
    BackingProcessing, ChannelMix, DocumentSettings, DrumKitMix, KitElement, PalmMuteIntensity,
    SlotKind, gm_kit_element,
};
use rustysynth::{Synthesizer, SynthesizerSettings};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::Arc,
};

const KIT_ELEMENTS: usize = KitElement::COUNT;

/// What each drum kit element is multiplied by, left and right, moving to a new target over a short ramp so a mute or a
/// level change never steps a ringing cymbal.
#[derive(Clone, Copy)]
struct KitGain {
    current: [[f32; 2]; KIT_ELEMENTS],
    target: [[f32; 2]; KIT_ELEMENTS],
    remaining: u32,
}
impl KitGain {
    fn new(kit: Option<&DrumKitMix>) -> Self {
        let target = kit.map_or([[1.0; 2]; KIT_ELEMENTS], |kit| {
            let elements = kit.elements();
            let any_solo = elements.iter().any(|e| e.solo);
            std::array::from_fn(|i| {
                let e = &elements[i];
                let gain = if !e.mute && (!any_solo || e.solo) {
                    e.gain
                } else {
                    0.0
                };
                [
                    gain * if e.pan > 0.0 { 1.0 - e.pan } else { 1.0 },
                    gain * if e.pan < 0.0 { 1.0 + e.pan } else { 1.0 },
                ]
            })
        });
        Self {
            current: target,
            target,
            remaining: 0,
        }
    }
    /// The multipliers for the next frame.
    fn step(&mut self) -> [[f32; 2]; KIT_ELEMENTS] {
        if self.remaining > 0 {
            let remaining = self.remaining as f32;
            for (current, target) in self.current.iter_mut().zip(&self.target) {
                for c in 0..2 {
                    current[c] += (target[c] - current[c]) / remaining;
                }
            }
            self.remaining -= 1;
        }
        self.current
    }
}
#[derive(Clone, Copy)]
struct Gain {
    current: [f32; 2],
    target: [f32; 2],
    remaining: u32,
}
impl Gain {
    fn new(mix: &ChannelMix, audible: bool) -> Self {
        let angle = (mix.pan as f64 + 1.0) * std::f64::consts::FRAC_PI_4;
        let gain = if audible { mix.gain } else { 0.0 };
        let target = [gain * angle.cos() as f32, gain * angle.sin() as f32];
        Self {
            current: target,
            target,
            remaining: 0,
        }
    }
    fn process(&mut self, x: [f32; 2]) -> [f32; 2] {
        if self.remaining > 0 {
            for c in 0..2 {
                self.current[c] += (self.target[c] - self.current[c]) / self.remaining as f32;
            }
            self.remaining -= 1;
        }
        std::array::from_fn(|c| x[c] * self.current[c])
    }
}
struct PreparedChannel {
    /// The plan track's id and whether it is a percussion track: an instrument plug-in is for a percussion track only.
    track_id: String,
    percussion: bool,
    dsp: TrackDsp,
    gain: Gain,
    mix: ChannelMix,
    kit: KitGain,
    /// Whether the kit mix changes anything. A kit of elements all at their defaults sounds as the track does without one.
    kit_active: bool,
    /// What the plan's notes become for the track's instrument plug-in: `Some` while the channel's insert is an
    /// instrument. Held by the mix, so a change of slot or of map is a mix change with no renderer rebuilt. The kit mix
    /// above shapes only the built-in stand-in; a hosted instrument has its own mixer.
    notes: Option<NoteMap>,
    /// The track's drum map, resolved where the mix is prepared (off the audio thread): General MIDI for a track with none
    /// and for any track that is not percussion. Only an instrument reads it, so the built-in sounds never do.
    drum_map: DrumMap,
    /// Whether the track's board has a plug-in, so the score's pan is applied to what the plug-in makes and not before it.
    /// An amp simulation is made for a guitar as it is played, and one that reads only its left input is silent for a track
    /// the score pans to the right: an effect hears the recorded voices without their pan, and the pan places its output.
    /// An instrument's sound replaces the voices altogether, so the pan has to be applied to what it makes; the built-in
    /// kit that stands in for it is placed by the same factor.
    pan_after: bool,
    /// Whether that plug-in is an instrument, so the voices that stand in for it keep the centre's level, not the louder
    /// side's (see [`pan_pre`]).
    pan_flat: bool,
}
impl PreparedChannel {
    /// Puts `insert` on the channel and says whether the plan's notes go to it.
    fn attach(&mut self, insert: Box<PluginInsert>) -> Result<(), InsertError> {
        if insert.kind() == SlotKind::Instrument && !self.percussion {
            return Err(InsertError::NotAPercussionTrack);
        }
        self.pan_after = true;
        self.pan_flat = insert.kind() == SlotKind::Instrument;
        self.notes =
            (insert.kind() == SlotKind::Instrument).then(|| NoteMap::with_drum_map(self.drum_map));
        self.dsp.attach_plugin(insert);
        Ok(())
    }
}
/// Hands the compensation over from the mix or renderer that is playing (`old`) to the one taking over (`new`).
/// - Both delay: the new lines take over the old history and crossfade to their own taps.
/// - Only the new one delays: it starts undelayed while the old board sounds, and glides to its delay.
/// - Only the old one delays: while it sounds, it glides to zero and stays with the new mix until the glide ends.
///
/// An old compensation that no longer does anything (`active` is false) counts as none, and stays with `old` to be
/// retired off the audio thread with it. Moves boxes and buffers; does not allocate.
fn carry_compensation(
    new: &mut Option<Box<Compensation>>,
    old: &mut Option<Box<Compensation>>,
    old_sounding: bool,
) {
    let old_active = old.as_ref().is_some_and(|c| c.active());
    match new.as_deref_mut() {
        Some(new_comp) => match old.as_deref_mut() {
            Some(old_comp) if old_active => new_comp.transition_from(old_comp),
            _ => {
                if old_sounding {
                    new_comp.start_undelayed();
                }
            }
        },
        None => {
            if old_sounding && old_active {
                if let Some(old_comp) = old.as_deref_mut() {
                    old_comp.retime_to_zero();
                }
                *new = old.take();
            }
        }
    }
}
pub struct PreparedMix {
    channels: Vec<PreparedChannel>,
    backing: Gain,
    pub(crate) master: MasterBus,
    rate: u32,
    pub(crate) compensation: Option<Box<Compensation>>,
    /// Tracks whose plug-in insert this mix refused, and why. Read on the control thread before the mix is sent; the
    /// audio thread never touches it.
    refused: Vec<(String, InsertError)>,
}
fn validate_mix(mix: &ChannelMix) -> Result<(), String> {
    if !mix.gain.is_finite()
        || !(0.0..=1.0).contains(&mix.gain)
        || !mix.pan.is_finite()
        || !(-1.0..=1.0).contains(&mix.pan)
    {
        Err("Invalid channel gain or pan.".into())
    } else {
        Ok(())
    }
}
impl PreparedMix {
    pub fn prepare(
        settings: &DocumentSettings,
        plan: &PlaybackPlan,
        sample_rate: u32,
    ) -> Result<Self, String> {
        Self::prepare_with_plugins(settings, plan, sample_rate, &[], 512)
    }

    pub fn prepare_with_plugins(
        settings: &DocumentSettings,
        plan: &PlaybackPlan,
        sample_rate: u32,
        plans: &[(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )],
        callback_frames: usize,
    ) -> Result<Self, String> {
        settings.validate()?;
        plan.validate()?;
        let any_solo = plan
            .tracks
            .iter()
            .any(|t| settings.mixes.get(&t.id).is_some_and(|m| m.solo))
            || settings.backing.as_ref().is_some_and(|b| b.mix.solo);
        let mut channels = Vec::with_capacity(plan.tracks.len());
        let pipeline_frames = tabplayer_plugin_protocol::limits::pipeline_frames(callback_frames);
        let plan_map: std::collections::HashMap<
            &str,
            &Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        > = plans.iter().map(|(id, res)| (id.as_str(), res)).collect();
        let mut refused = Vec::new();

        for (index, track) in plan.tracks.iter().enumerate() {
            let mix = settings.mixes.get(&track.id).cloned().unwrap_or_default();
            validate_mix(&mix)?;
            let fx = settings
                .sounds
                .get(&track.id)
                .map(|s| s.effects.clone())
                .unwrap_or_else(FxSettings::default);
            let mut dsp = TrackDsp::new(fx, sample_rate, MAX_TRACK_DELAY_SECONDS)?;
            dsp.set_ir_index(index);
            let mut notes = None;
            let mut pan_after = false;
            let mut pan_flat = false;
            let drum_map = drum_map::resolve(mix.drum_map.as_ref(), track.percussion);

            if let Some(Ok(plan)) = plan_map.get(track.id.as_str()) {
                // A refusal leaves the track on its built-in sound and is named, so the slot can say why.
                if plan.kind == SlotKind::Instrument && !track.percussion {
                    refused.push((track.id.clone(), InsertError::NotAPercussionTrack));
                } else {
                    match PluginInsert::new_of_kind(
                        plan.kind,
                        plan.link.clone(),
                        crate::audio::plugin_insert::InsertMode::Realtime { pipeline_frames },
                        plan.latency,
                        plan.input_db,
                        plan.output_db,
                        sample_rate,
                        plan.shared.clone(),
                    ) {
                        Ok(insert) => {
                            notes = (plan.kind == SlotKind::Instrument)
                                .then(|| NoteMap::with_drum_map(drum_map));
                            pan_after = true;
                            pan_flat = plan.kind == SlotKind::Instrument;
                            dsp.attach_plugin(Box::new(insert));
                        }
                        Err(error) => refused.push((track.id.clone(), error)),
                    }
                }
            }

            let kit = mix.drum_kit.as_ref().filter(|kit| !kit.is_neutral());
            channels.push(PreparedChannel {
                track_id: track.id.clone(),
                percussion: track.percussion,
                dsp,
                gain: Gain::new(&mix, !mix.mute && (!any_solo || mix.solo)),
                kit: KitGain::new(kit),
                kit_active: kit.is_some(),
                notes,
                drum_map,
                pan_after,
                pan_flat,
                mix,
            });
        }
        let backing = settings
            .backing
            .as_ref()
            .map(|b| b.mix.clone())
            .unwrap_or_default();
        validate_mix(&backing)?;
        let mut mix = Self {
            channels,
            backing: Gain::new(&backing, !backing.mute && (!any_solo || backing.solo)),
            master: MasterBus::new(settings.master.as_ref(), sample_rate)?,
            rate: sample_rate,
            compensation: None,
            refused,
        };
        mix.update_compensation();
        Ok(mix)
    }
    /// The tracks whose plug-in insert this mix refused, and why, in track order.
    pub fn plugin_refusals(&self) -> &[(String, InsertError)] {
        &self.refused
    }
    /// Accessor for delay compensation.
    pub fn compensation(&self) -> Option<&Compensation> {
        self.compensation.as_deref()
    }
    /// Maximum delay among all stems in this mix.
    pub fn plugin_delay_frames(&self) -> usize {
        self.compensation.as_ref().map_or(0, |c| c.d_max())
    }
    /// Attaches plug-in inserts to the corresponding channels and computes delay compensation.
    pub fn with_inserts(mut self, inserts: Vec<Option<Box<PluginInsert>>>) -> Self {
        for (i, insert) in inserts.into_iter().enumerate() {
            if let Some(insert) = insert {
                if i < self.channels.len() {
                    self.attach(i, insert);
                }
            }
        }
        self.update_compensation();
        self
    }
    /// Attaches an insert to track `track` and updates delay compensation.
    pub fn attach_plugin(&mut self, track: usize, insert: Box<PluginInsert>) {
        if track < self.channels.len() {
            self.attach(track, insert);
            self.update_compensation();
        }
    }
    /// Puts `insert` on channel `track`, or refuses it, with the reason named for the slot, where the track cannot take it.
    fn attach(&mut self, track: usize, insert: Box<PluginInsert>) {
        if let Err(error) = self.channels[track].attach(insert) {
            self.refused
                .push((self.channels[track].track_id.clone(), error));
        }
    }
    fn update_compensation(&mut self) {
        let delays: Vec<usize> = self.channels.iter().map(|c| c.dsp.plugin_delay()).collect();
        let d_max = *delays.iter().max().unwrap_or(&0);
        if d_max > 0 {
            let cap = compensation_capacity(self.rate);
            self.compensation = Some(Box::new(Compensation::new_with_rate(
                &delays, cap, self.rate,
            )));
        } else {
            self.compensation = None;
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub struct RenderStatus {
    pub frames: usize,
    pub tick: f64,
    pub seconds: f64,
    pub ended: bool,
    pub pulse_count: u32,
    pub last_pulse: Option<PulsePosition>,
}
#[derive(Clone)]
struct VoiceSample {
    audio: Arc<DecodedAudio>,
    parameters: VoiceParameters,
    release_decay: f64,
    /// Frames of recorded silence before a muted or dead note's pick, and the voice's palm mute and dead note trims in dB: measured and
    /// looked up while preparing, so starting a note on the audio thread scans nothing.
    lead_frames: f64,
    trims_db: (f64, f64),
    palm_mute_string: Option<u8>,
    palm_mute_strength: f64,
}
impl VoiceSample {
    fn new(
        resources: &AudioResources,
        region: &Region,
        key: u8,
        velocity: u8,
        articulation: Articulation,
    ) -> Result<Self, String> {
        let audio = resources
            .samples
            .get(&region.sample_id)
            .ok_or_else(|| format!("Missing prepared sample {}.", region.sample_id))?
            .clone();
        let parameters = VoiceParameters {
            root_key: region.root_key,
            key,
            velocity,
            articulation,
            attack_seconds: region.attack_seconds,
            release_seconds: region.release_seconds,
            gain_db: region.gain_db,
            loop_start: region.loop_start,
            loop_end: region.loop_end,
            pitch_keytrack: region.pitch_keytrack,
            velocity_gain_high: region.velocity_gain_high,
            tuning_cents: region.tuning_cents,
            is_recorded_harmonic: region.articulation == "harmonic",
        };
        Ok(Self {
            audio,
            parameters,
            release_decay: region.release_decay_db_per_second,
            lead_frames: 0.0,
            trims_db: (0.0, 0.0),
            palm_mute_string: None,
            palm_mute_strength: DEFAULT_PALM_MUTE_STRENGTH,
        })
    }
    fn instantiate(&self, rate: u32) -> SampleVoice {
        SampleVoice::prepared(
            self.audio.clone(),
            self.parameters,
            rate,
            self.lead_frames,
            self.trims_db,
        )
        .expect("sample validated during preparation")
        .with_palm_mute(self.palm_mute_string, self.palm_mute_strength)
    }
}
#[derive(Clone)]
struct SelectedNote {
    track: usize,
    instrument: usize,
    attack: VoiceSample,
    release: Option<VoiceSample>,
    noise: Option<VoiceSample>,
    chain: Option<usize>,
    suppress_pick: bool,
    drum: Option<DrumVoice>,
}
/// How a note of the recorded kit plays: struck and left to ring out, unless it is choked, when it stops quickly at the
/// note's end. Its group stops the voices on its track that this group cuts, as a closed hi-hat stops an open one.
#[derive(Clone, Copy)]
struct DrumVoice {
    group: u32,
    off_by: u32,
    choke: bool,
}
/// The channel a guitar or bass track's golpe knocks play on: General MIDI's percussion channel. A hit there that no plan
/// note owns is played by the track's General MIDI synthesizer from the sound bank's Standard kit, whatever voice the track has.
const KNOCK_CHANNEL: u8 = 9;
/// The sound bank's Standard kit.
const KNOCK_KIT: u8 = 0;
/// How fast a choked cymbal falls silent once the hand stops it.
const CHOKE_RELEASE_SECONDS: f64 = 0.06;
/// How many strokes of one drum sound ring on one track at once. A cymbal rings for up to 14 s, so a ride played in
/// eighths would otherwise keep dozens of voices running; a new stroke fades the oldest beyond this.
const MAX_RINGING_STROKES: usize = 4;
/// A recorded drum voice: the kit element it is mixed with, the group that stops it, and its kit sound.
#[derive(Clone, Copy)]
struct RingingDrum {
    element: usize,
    off_by: u32,
    sound: u8,
}
struct ActiveVoice {
    note: usize,
    track: usize,
    channel: u8,
    voice: SampleVoice,
    end_tick: f64,
    released: bool,
    release: Option<VoiceSample>,
    started_seconds: f64,
    unpitched: bool,
    drum: Option<RingingDrum>,
}
#[derive(Clone, Copy)]
struct MidiChannel {
    program: u8,
    volume: f32,
    expression: f32,
    pan: [f32; 2],
    sustain: bool,
}
impl MidiChannel {
    fn new(program: u8) -> Self {
        Self {
            program,
            volume: 1.0,
            expression: 1.0,
            pan: [1.0; 2],
            sustain: false,
        }
    }
    fn process(&self, sample: [f32; 2]) -> [f32; 2] {
        std::array::from_fn(|c| sample[c] * self.volume * self.expression * self.pan[c])
    }
    /// [`process`](Self::process) with the score's pan moved out of the voices by `blend` (see [`pan_pre`]): 0 is the pan as
    /// the score has it, 1 the same level on both sides, that of the louder side for an effect's track and the centre's for an
    /// instrument's (`flat`, 0 to 1 between the two).
    fn process_blended(&self, sample: [f32; 2], blend: f32, flat: f32) -> [f32; 2] {
        let pre = pan_pre(self.pan, blend, flat);
        std::array::from_fn(|c| sample[c] * self.volume * self.expression * pre[c])
    }
}
/// How much of the score's `pan` a track's voices keep when the pan is applied after its board, by `blend` (0 all of it, 1
/// none). A guitar amp simulation is made for a guitar as it is played, and one that reads only its left input is silent for
/// a track the score pans to the right, so what enters the board is the same on both sides, at the level of the louder one.
/// That is the level the board's amp saw before, and what a stage that measures a level (a gate, a compressor) measured.
/// The voices that stand in for an instrument (`flat` 1) keep the level of the centre, 1 on both sides, because the pan is
/// applied to the instrument's output as it is, the louder side's factor above 1 included, and the stand-in is placed by
/// the same factor. `flat` moves between the two (0 the louder side's level) over the 10 ms a plug-in of the other kind
/// takes to replace one, so what the leaving plug-in still plays is not placed by a different factor from one frame to the
/// next. The pan after the board ([`pan_post`]) is the rest, so the two multiply to `pan` all along a glide between them.
fn pan_pre(pan: [f32; 2], blend: f32, flat: f32) -> [f32; 2] {
    let louder = pan[0].max(pan[1]);
    let loud = if flat <= 0.0 {
        louder
    } else if flat >= 1.0 {
        1.0
    } else {
        louder + (1.0 - louder) * flat
    };
    std::array::from_fn(|c| pan[c] + (loud - pan[c]) * blend)
}
/// What is left of the score's `pan` to apply after the board when the voices kept [`pan_pre`] of it.
fn pan_post(pan: [f32; 2], blend: f32, flat: f32) -> [f32; 2] {
    if blend == 0.0 {
        return [1.0; 2];
    }
    let pre = pan_pre(pan, blend, flat);
    std::array::from_fn(|c| if pre[c] > 0.0 { pan[c] / pre[c] } else { 1.0 })
}
/// Moves of the pan after the board that the board's delay still holds back (see `Track::pan_queue`).
const PAN_MOVES: usize = 16;
#[derive(Clone, Copy)]
struct MidiAttack {
    program: u8,
    recorded: bool,
}
struct Track {
    synth: Option<Synthesizer>,
    /// One synthesizer per kit element, on a percussion track. They sound only while a kit mix is in effect, and render only once
    /// one of them has been struck since the last seek.
    drum_synths: Option<[Synthesizer; KIT_ELEMENTS]>,
    kit_active: bool,
    drum_used: bool,
    /// Whether a frame has been rendered since the last seek, which is when a kit level change has been heard to ramp.
    kit_rendered: bool,
    recorded_programs: [bool; 128],
    locked: bool,
    /// The program each channel starts a seek or a render from: the track's own, or for a locked track the sound in effect at the start.
    start_programs: [u8; 16],
    percussion: bool,
    channels: [MidiChannel; 16],
    /// The pan the score last set on any of the track's channels, as the factors for the two sides, and the controller
    /// value each channel was last given. See `pan_after`.
    pan: [f32; 2],
    pan_cc: [u8; 16],
    /// Whether the track's board has a plug-in (`PreparedChannel::pan_after`), so the score's pan is applied after the
    /// plug-in, to what it makes, and not before it: the recorded voices play without their pan (`pan_pre`), the General
    /// MIDI synthesizers are told the centre, and the pan places the plug-in's output (`pan_post`). An amp simulation is
    /// made for a guitar as it is played, and one that reads only its left input is silent for a track the score pans to
    /// the right; an instrument replaces the voices, so what it makes is placed and the built-in kit that stands in for it
    /// is placed the same.
    pan_after: bool,
    /// Whether that plug-in is an instrument (`PreparedChannel::pan_flat`). It keeps its value while the plug-in goes, so the
    /// leaving plug-in is placed as it was until it has faded.
    pan_flat: bool,
    /// Where `pan_pre` has the level the voices keep between the louder side's (0) and the centre's (1): it glides to
    /// `pan_flat` over 10 ms, as `pan_blend` does to `pan_after`.
    pan_flat_mix: f32,
    /// How far the pan has moved from before the board (0) to after it (1). It glides over 10 ms when `pan_after` changes,
    /// so adding or removing a plug-in on a panned track does not step.
    pan_blend: f32,
    /// Whether the General MIDI synthesizers have been told the centre, which they are once the pan is after the board and
    /// until the next seek, so their own pan is not applied on top of the renderer's.
    synth_centred: bool,
    /// The pan the plug-in's output is placed by. It trails `pan` by the board's delay, because the output of a frame is
    /// what entered the plug-in that many frames ago, when the score's pan was what it was then. `pan_seen` is the last
    /// `pan` it was told of, and `pan_queue` the moves of it that have not reached the output yet, as frames to wait and the
    /// pan they bring, oldest first.
    pan_late: [f32; 2],
    pan_seen: [f32; 2],
    pan_queue: [(u32, [f32; 2]); PAN_MOVES],
    pan_queued: usize,
    ranges: [f64; 16],
    rpn_msb: [u8; 16],
    rpn_lsb: [u8; 16],
}
impl Track {
    /// Moves the score's pan before or after the board (see `pan_after`). The synthesizers are given the pan they should
    /// play with now: the centre while it is applied after the board, the score's own otherwise. Allocates nothing.
    fn set_pan_after(&mut self, after: bool, flat: bool) {
        self.pan_after = after;
        // A plug-in that goes leaves `flat` as it was: the plug-in is still in its 10 ms fade, placed by the factor it had,
        // and the glide to the pan before the board (where `flat` makes no difference) is what moves it.
        if after {
            self.pan_flat = flat;
        }
        self.sync_synth_pan();
    }
    /// What the plug-in's output is multiplied by to place it: the part of the score's pan the voices did not keep.
    fn pan_after_factors(&self) -> [f32; 2] {
        pan_post(self.pan_late, self.pan_blend, self.pan_flat_mix)
    }
    /// What a General MIDI synthesizer told the centre is multiplied by, so it plays the pan the voices keep. 1 for a
    /// synthesizer that pans itself.
    fn synth_factors(&self) -> [f32; 2] {
        if self.synth_centred {
            pan_pre(self.pan, self.pan_blend, self.pan_flat_mix)
        } else {
            [1.0; 2]
        }
    }
    /// Moves `pan_blend` and `pan_flat_mix` a step (`1 / 10 ms`) toward where `pan_after` and `pan_flat` say they should be.
    fn glide_pan(&mut self, step: f32) {
        let aim = if self.pan_after { 1.0 } else { 0.0 };
        let flat_aim = if self.pan_flat { 1.0 } else { 0.0 };
        if self.pan_blend == aim && self.pan_flat_mix == flat_aim {
            return;
        }
        if self.pan_blend < aim {
            self.pan_blend = (self.pan_blend + step).min(aim);
        } else if self.pan_blend > aim {
            self.pan_blend = (self.pan_blend - step).max(aim);
        }
        if self.pan_flat_mix < flat_aim {
            self.pan_flat_mix = (self.pan_flat_mix + step).min(flat_aim);
        } else if self.pan_flat_mix > flat_aim {
            self.pan_flat_mix = (self.pan_flat_mix - step).max(flat_aim);
        }
        self.sync_synth_pan();
    }
    /// Puts `pan_blend` where `pan_after` says it should be at once, and the synthesizers with it.
    fn settle_pan(&mut self) {
        self.pan_blend = if self.pan_after { 1.0 } else { 0.0 };
        self.pan_flat_mix = if self.pan_flat { 1.0 } else { 0.0 };
        if self.synth_centred != self.pan_after {
            self.synth_centred = self.pan_after;
            for channel in 0..16 {
                self.send_pan(channel);
            }
        }
    }
    /// Lets the pan that places the plug-in's output follow the score's, `delay` frames late (the frames the plug-in's
    /// pipeline and latency take). Call it once a frame, after the frame's MIDI events.
    fn step_pan(&mut self, delay: usize) {
        for (wait, _) in &mut self.pan_queue[..self.pan_queued] {
            *wait = wait.saturating_sub(1);
        }
        if self.pan != self.pan_seen {
            self.pan_seen = self.pan;
            if self.pan_queued == PAN_MOVES {
                // More moves than the queue holds: the oldest takes effect now, a little early.
                self.pan_late = self.pan_queue[0].1;
                self.pan_queue.copy_within(1.., 0);
                self.pan_queued -= 1;
            }
            self.pan_queue[self.pan_queued] = (delay.min(u32::MAX as usize) as u32, self.pan);
            self.pan_queued += 1;
        }
        let mut due = 0;
        while due < self.pan_queued && self.pan_queue[due].0 == 0 {
            self.pan_late = self.pan_queue[due].1;
            due += 1;
        }
        if due > 0 {
            self.pan_queue.copy_within(due.., 0);
            self.pan_queued -= due;
        }
    }
    /// Tells the synthesizers the centre once the pan is after the board. They keep it when the plug-in goes, and the
    /// renderer goes on placing them by the score's pan (`synth_factors`) until the next seek (`settle_pan`): a synthesizer
    /// that is handed its pan back moves its voices to it over a block of its own, while a factor outside it moves at once,
    /// and the two together are heard as a click.
    fn sync_synth_pan(&mut self) {
        if !self.synth_centred && (self.pan_after || self.pan_blend > 0.0) {
            self.synth_centred = true;
            for channel in 0..16 {
                self.send_pan(channel);
            }
        }
    }
    /// Tells the track's synthesizers the pan of `channel`: the score's, or the centre while the pan is after the board.
    fn send_pan(&mut self, channel: usize) {
        let value = if self.synth_centred {
            64
        } else {
            self.pan_cc[channel]
        };
        if let Some(synths) = &mut self.drum_synths {
            for synth in synths.iter_mut() {
                synth.process_midi_message(channel as i32, 0xb0, 10, i32::from(value));
            }
        }
        if let Some(synth) = &mut self.synth {
            synth.process_midi_message(channel as i32, 0xb0, 10, i32::from(value));
        }
    }
    /// Whether a MIDI attack that no plan note owns is a golpe knock: on the percussion channel of a track that is not a
    /// drum track.
    fn is_knock(&self, channel: u8, attack: Option<MidiAttack>) -> bool {
        attack.is_none() && !self.percussion && channel == KNOCK_CHANNEL
    }
    /// Whether a MIDI attack with no plan note plays a recorded voice. A drum attack never does: the kit knows its sound
    /// only from the note.
    fn recorded_program(&self, program: u8) -> bool {
        !self.percussion
            && self
                .recorded_programs
                .get(program as usize)
                .copied()
                .unwrap_or(false)
    }
}

fn resolve_renderer_voice(
    track: &super::plan::PlanTrack,
    settings: &DocumentSettings,
    program: u8,
    resources: &AudioResources,
) -> Option<String> {
    let has = |id: &str| resources.manifest.instruments.iter().any(|i| i.id == id);
    let sound = settings.sounds.get(&track.id);
    let voice_id = sound.and_then(|s| s.voice_id.as_deref());
    let pickup = sound.and_then(|s| s.pickup.as_deref());
    let drum_kit = drum_kit_for_track(track, settings);
    if let Some(id) = resolve_voice_id(voice_id, pickup, track.percussion, drum_kit, program) {
        if has(&id) {
            return Some(id);
        }
        // If a GP8 voice failed or returned empty (e.g., partial perc kit), fall back cleanly to GM.
        return None;
    }
    if voice_id == Some("gm") {
        return None;
    }
    // Preserve strict error behavior when a caller supplies synthetic non-GP8 manifest instruments in tests.
    let has_synthetic = resources
        .manifest
        .instruments
        .iter()
        .any(|i| !i.id.starts_with("gp8:"));
    if !has_synthetic {
        return None;
    }
    if let Some(explicit) = voice_id {
        if !explicit.starts_with("gp8:") {
            return Some(explicit.to_owned());
        }
        return None;
    }
    legacy_automatic_voice_id(program, track.percussion).map(str::to_owned)
}

/// What a drum note plays from the recorded kit: the recording of its kit sound, by velocity and round robin. None, which
/// plays it from General MIDI, for a sound the kit has no recording of, or a track on another kit.
fn select_drum(
    plan: &PlaybackPlan,
    note: &PlanNote,
    track: usize,
    settings: &DocumentSettings,
    resources: &AudioResources,
    sample_rate: u32,
    counters: &mut HashMap<(usize, usize, u8, u8, &'static str), usize>,
) -> Result<Option<SelectedNote>, String> {
    let plan_track = &plan.tracks[track];
    let Some(sound) = note.kit_sound else {
        return Ok(None);
    };
    let Some(id) = resolve_renderer_voice(
        plan_track,
        settings,
        effective_note_program(plan, note, settings),
        resources,
    ) else {
        return Ok(None);
    };
    // A guitar or bass voice chosen for a drum track has no drums; the track plays General MIDI.
    if !is_drum_instrument(&id) {
        return Ok(None);
    }
    let index = resources
        .manifest
        .instruments
        .iter()
        .position(|i| i.id == id)
        .ok_or_else(|| format!("Unknown recorded instrument {id}."))?;
    let instrument = &resources.manifest.instruments[index];
    let counter = counters
        .entry((track, index, sound, note.velocity, "drum"))
        .or_default();
    let sequence = *counter;
    *counter += 1;
    let recorded_choke = if note.choke {
        select_region_by_name(
            instrument,
            sound,
            note.velocity,
            "choke",
            sequence,
            "attack",
        )
        .filter(|r| (r.key_low..=r.key_high).contains(&sound))
    } else {
        None
    };
    // Only the sound itself: a neighbouring key's recording would be another drum.
    let (region, shorten_release) = if let Some(region) = recorded_choke {
        (region, false)
    } else {
        let Some(region) = select_region(
            instrument,
            sound,
            note.velocity,
            Articulation::Picked,
            sequence,
            "attack",
        )
        .filter(|r| (r.key_low..=r.key_high).contains(&sound)) else {
            return Ok(None);
        };
        (region, note.choke)
    };
    let mut attack = VoiceSample::new(
        resources,
        region,
        sound,
        note.velocity,
        Articulation::Picked,
    )?;
    if shorten_release {
        attack.parameters.release_seconds = CHOKE_RELEASE_SECONDS;
    }
    SampleVoice::new(attack.audio.clone(), attack.parameters, sample_rate)?;
    Ok(Some(SelectedNote {
        track,
        instrument: index,
        attack,
        release: None,
        noise: None,
        chain: None,
        suppress_pick: false,
        drum: Some(DrumVoice {
            group: region.group,
            off_by: region.off_by,
            choke: note.choke,
        }),
    }))
}
pub struct Renderer {
    plan: Arc<PlaybackPlan>,
    timeline: Timeline,
    fixed_timeline: Timeline,
    _resources: Arc<AudioResources>,
    rate: u32,
    tempo: RenderTempo,
    seconds: f64,
    clock_origin_seconds: f64,
    clock_origin_fixed_seconds: f64,
    clock_origin_tick: f64,
    clock_frames: u64,
    tracks: Vec<Track>,
    selected: Vec<Option<SelectedNote>>,
    midi_attacks: Vec<Option<MidiAttack>>,
    note_has_midi: Vec<bool>,
    note_programs: Vec<u8>,
    /// The kit element the plan names for each note's MIDI attack, where it names one.
    note_kit: Vec<Option<KitElement>>,
    note_end_ticks: Vec<f64>,
    slots: Vec<Option<ActiveVoice>>,
    active: Vec<usize>,
    next_note: usize,
    next_midi: usize,
    /// The tick of the last frame whose notes and MIDI events were dispatched, `None` after a seek. An edit hand-over
    /// starts the new renderer's cursors from it, so an event between that frame and the next is dispatched once.
    dispatched_through: Option<f64>,
    /// Set by a seek, a wrap or an export's first seek: the hosted instruments are still to be struck for the keys the plan
    /// holds there. The first frame rendered after it does that, not the seek, so a count-in between the two (which runs the
    /// inserts) sends no strike and the music's first frame carries them.
    restrike_pending: bool,
    /// The plan track of each MIDI event, to find a track's events without comparing names.
    midi_track: Vec<u16>,
    /// External MIDI output: the tracks routed to a port. Offline exports never have one, so they render every track.
    midi: Option<Box<MidiTap>>,
    /// How much of each track's internal sound is heard: 1 normally, ramping to 0 over a few milliseconds when the
    /// track moves to a MIDI port and back when it returns, so the change is never a click.
    midi_fade: Vec<f32>,
    midi_fade_step: f32,
    mix: PreparedMix,
    /// The mix that arrived while this one was crossfading, waiting for that to end. Taking over mid-fade would drop
    /// the sound the fade is leaving, which is a click.
    parked_mix: Option<PreparedMix>,
    scratch: Vec<[f32; 2]>,
    /// Each track's recorded drum voices of this frame, by kit element, before the element mix.
    kit_scratch: Vec<[[f32; 2]; KIT_ELEMENTS]>,
    backing: Option<BackingVoice>,
    configured_backing: bool,
    tail: bool,
    metronome: MetronomeSettings,
    last_click: Option<(usize, usize)>,
    click: ClickVoice,
}
impl Renderer {
    pub fn new(
        plan: Arc<PlaybackPlan>,
        resources: Arc<AudioResources>,
        settings: DocumentSettings,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let mix = PreparedMix::prepare(&settings, &plan, sample_rate)?;
        Self::new_with_mix(plan, resources, mix, settings, sample_rate)
    }

    pub fn new_with_plugins(
        plan: Arc<PlaybackPlan>,
        resources: Arc<AudioResources>,
        settings: DocumentSettings,
        sample_rate: u32,
        plans: &[(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )],
        callback_frames: usize,
    ) -> Result<Self, String> {
        let mix = PreparedMix::prepare_with_plugins(
            &settings,
            &plan,
            sample_rate,
            plans,
            callback_frames,
        )?;
        Self::new_with_mix(plan, resources, mix, settings, sample_rate)
    }
    pub fn new_with_mix(
        plan: Arc<PlaybackPlan>,
        resources: Arc<AudioResources>,
        mix: PreparedMix,
        settings: DocumentSettings,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let plan = with_drum_kits(with_locked_articulations(plan, &settings), &settings);
        let timeline = Timeline::new(&plan)?;
        let fixed_timeline = Timeline::with_capacity(
            plan.fermatas
                .as_deref()
                .map_or(0, |fermatas| fermatas.len() * 2 + 1),
        );
        let track_indices: HashMap<_, _> = plan
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| (t.id.as_str(), i))
            .collect();
        let note_indices: HashMap<_, _> = plan
            .notes
            .iter()
            .enumerate()
            .map(|(i, n)| (n.id.as_str(), i))
            .collect();
        // A track with percussion-channel hits needs a General MIDI synthesizer to play them, whatever its voice.
        let knocks: HashSet<&str> = plan
            .midi
            .iter()
            .filter_map(|event| match event {
                PlanMidiEvent::NoteOn {
                    track_id,
                    channel: KNOCK_CHANNEL,
                    ..
                } => Some(track_id.as_str()),
                _ => None,
            })
            .collect();
        let mut tracks = Vec::with_capacity(plan.tracks.len());
        for (track_index, track) in plan.tracks.iter().enumerate() {
            // A drum track loads only the kit sounds its notes ask for; any other voice on it plays General MIDI.
            if let Some(id) = resolve_renderer_voice(track, &settings, track.program, &resources)
                .filter(|_| !track.percussion)
            {
                if !resources.manifest.instruments.iter().any(|i| i.id == id) {
                    return Err(format!("Unknown recorded instrument {id}."));
                }
            }
            // A drum track keeps General MIDI for the sounds the recorded kit lacks.
            let has_gm = track.percussion
                || knocks.contains(track.id.as_str())
                || resolve_renderer_voice(track, &settings, track.program, &resources).is_none()
                || plan.notes.iter().any(|n| {
                    n.track_id == track.id
                        && resolve_renderer_voice(
                            track,
                            &settings,
                            effective_note_program(&plan, n, &settings),
                            &resources,
                        )
                        .is_none()
                });
            let recorded_programs = std::array::from_fn(|p| {
                !track.percussion
                    && resolve_renderer_voice(track, &settings, p as u8, &resources)
                        .is_some_and(|id| resources.manifest.instruments.iter().any(|i| i.id == id))
            });
            let locked = track_locked(&settings, &track.id);
            let start_programs: [u8; 16] = std::array::from_fn(|channel| {
                if locked {
                    start_program(&plan, &track.id, channel as u8)
                } else {
                    track.program
                }
            });
            let make_synth = || -> Result<Synthesizer, String> {
                let mut config = SynthesizerSettings::new(sample_rate as i32);
                config.maximum_polyphony = 256;
                config.block_size = 8;
                config.enable_reverb_and_chorus = false;
                let mut synth =
                    Synthesizer::new(&resources.sound_font, &config).map_err(|e| e.to_string())?;
                for channel in 0..16 {
                    synth.process_midi_message(
                        channel,
                        0xc0,
                        start_programs[channel as usize] as i32,
                        0,
                    );
                }
                Ok(synth)
            };
            let synth = if has_gm { Some(make_synth()?) } else { None };
            // A percussion track keeps one synthesizer per kit element beside its own, idle until a kit mix is in
            // effect, so a kit mix is installed like any other mix, without rebuilding the renderer.
            let drum_synths = if has_gm && track.percussion {
                let built = (0..KIT_ELEMENTS)
                    .map(|_| make_synth())
                    .collect::<Result<Vec<_>, _>>()?;
                Some(
                    <[Synthesizer; KIT_ELEMENTS]>::try_from(built)
                        .map_err(|_| "Drum kit synthesizers are missing.".to_string())?,
                )
            } else {
                None
            };
            tracks.push(Track {
                synth,
                drum_synths,
                recorded_programs,
                locked,
                start_programs,
                kit_active: mix.channels[track_index].kit_active,
                drum_used: false,
                kit_rendered: false,
                percussion: track.percussion,
                channels: std::array::from_fn(|c| MidiChannel::new(start_programs[c])),
                pan: [1.0; 2],
                pan_cc: [64; 16],
                pan_after: false,
                pan_flat: false,
                pan_flat_mix: 0.0,
                pan_blend: 0.0,
                synth_centred: false,
                pan_late: [1.0; 2],
                pan_seen: [1.0; 2],
                pan_queue: [(0, [1.0; 2]); PAN_MOVES],
                pan_queued: 0,
                ranges: [2.0; 16],
                rpn_msb: [127; 16],
                rpn_lsb: [127; 16],
            });
        }
        let note_programs: Vec<_> = plan
            .notes
            .iter()
            .map(|n| effective_note_program(&plan, n, &settings))
            .collect();
        let sustain_events: Vec<_> = plan
            .midi
            .iter()
            .filter_map(|event| match event {
                PlanMidiEvent::Controller {
                    track_id,
                    tick,
                    channel,
                    controller: 64,
                    value,
                } => Some((track_id.as_str(), *tick, *channel, *value >= 64)),
                _ => None,
            })
            .collect();
        let note_end_ticks: Vec<_> = plan
            .notes
            .iter()
            .map(|note| {
                let mut down = false;
                for &(track, tick, channel, sustain) in &sustain_events {
                    if track != note.track_id || channel != note.channel.unwrap_or(0) {
                        continue;
                    }
                    if tick <= note.end_tick {
                        down = sustain;
                    } else if down && !sustain {
                        return tick;
                    }
                }
                if down {
                    plan.duration_tick.max(note.end_tick)
                } else {
                    note.end_tick
                }
            })
            .collect();
        let mut counters = HashMap::<(usize, usize, u8, u8, &str), usize>::new();
        let mut lead_cache = HashMap::<String, f64>::new();
        let mut selected = Vec::with_capacity(plan.notes.len());
        for note in &plan.notes {
            let track = track_indices[note.track_id.as_str()];
            if plan.tracks[track].percussion {
                selected.push(select_drum(
                    &plan,
                    note,
                    track,
                    &settings,
                    &resources,
                    sample_rate,
                    &mut counters,
                )?);
                continue;
            }
            if let Some(id) = resolve_renderer_voice(
                &plan.tracks[track],
                &settings,
                effective_note_program(&plan, note, &settings),
                &resources,
            ) {
                let index = resources
                    .manifest
                    .instruments
                    .iter()
                    .position(|i| i.id == id)
                    .ok_or_else(|| format!("Unknown recorded instrument {id}."))?;
                let instrument = &resources.manifest.instruments[index];
                let counter = counters
                    .entry((
                        track,
                        index,
                        note.key,
                        note.velocity,
                        articulation_name(note.articulation),
                    ))
                    .or_default();
                let sequence = *counter;
                if note.legato_from.is_none() {
                    *counter += 1;
                }
                let tonal = if note.articulation == Articulation::Feedback {
                    Articulation::Picked
                } else {
                    note.articulation
                };
                let region = select_region(
                    instrument,
                    note.key,
                    note.velocity,
                    tonal,
                    sequence,
                    "attack",
                )
                .ok_or_else(|| {
                    format!("No recorded attack for {} key {}.", instrument.id, note.key)
                })?;
                let mut attack = VoiceSample::new(
                    &resources,
                    region,
                    note.key,
                    note.velocity,
                    note.articulation,
                )?;
                attack.trims_db = super::voices::technique_trims_db(&instrument.id);
                attack.palm_mute_string = note
                    .source
                    .string
                    .checked_sub(1)
                    .map(|s| s.min(u8::MAX as u32) as u8);
                attack.palm_mute_strength = match settings
                    .mixes
                    .get(&note.track_id)
                    .and_then(|m| m.interpretation.as_ref())
                    .and_then(|i| i.palm_mute)
                {
                    Some(PalmMuteIntensity::Heavy) => HEAVY_PALM_MUTE_STRENGTH,
                    _ => DEFAULT_PALM_MUTE_STRENGTH,
                };
                if matches!(note.articulation, Articulation::Muted | Articulation::Dead) {
                    // One measurement per recording, however many notes use it.
                    attack.lead_frames = *lead_cache
                        .entry(region.sample_id.clone())
                        .or_insert_with(|| super::voices::lead_in_frames(&attack.audio));
                }
                SampleVoice::prepared(
                    attack.audio.clone(),
                    attack.parameters,
                    sample_rate,
                    attack.lead_frames,
                    attack.trims_db,
                )?
                .with_palm_mute(attack.palm_mute_string, attack.palm_mute_strength);
                // A palm mute or dead note ends with the string stopped by the hand: no string-release recording.
                let release = select_region(
                    instrument,
                    note.key,
                    note.velocity,
                    tonal,
                    sequence,
                    "release",
                )
                .filter(|_| !matches!(note.articulation, Articulation::Muted | Articulation::Dead))
                .map(|r| {
                    VoiceSample::new(&resources, r, note.key, note.velocity, Articulation::Picked)
                })
                .transpose()?;
                let noise = if note.articulation == Articulation::Feedback {
                    select_region(
                        instrument,
                        note.key,
                        note.velocity,
                        Articulation::Feedback,
                        sequence,
                        "attack",
                    )
                    .filter(|r| r.articulation == "feedback")
                    .map(|r| {
                        VoiceSample::new(
                            &resources,
                            r,
                            note.key,
                            note.velocity,
                            Articulation::Feedback,
                        )
                    })
                    .transpose()?
                } else {
                    None
                };
                for sample in release.iter().chain(noise.iter()) {
                    SampleVoice::new(sample.audio.clone(), sample.parameters, sample_rate)?;
                }
                selected.push(Some(SelectedNote {
                    track,
                    instrument: index,
                    attack,
                    release,
                    noise,
                    chain: note
                        .legato_from
                        .as_ref()
                        .map(|id| note_indices[id.as_str()]),
                    suppress_pick: matches!(
                        note.articulation,
                        Articulation::Legato | Articulation::Tapped
                    ) && region.articulation != "legato",
                    drum: None,
                }));
            } else {
                selected.push(None);
            }
        }
        let mut attacks = HashMap::<(usize, u8, u8, u64), VecDeque<usize>>::new();
        for (index, note) in plan.notes.iter().enumerate() {
            attacks
                .entry((
                    track_indices[note.track_id.as_str()],
                    note.channel.unwrap_or(0),
                    note.key,
                    note.start_tick.to_bits(),
                ))
                .or_default()
                .push_back(index);
        }
        let mut note_has_midi = vec![false; plan.notes.len()];
        let mut note_kit = vec![None; plan.notes.len()];
        let midi_attacks = plan
            .midi
            .iter()
            .map(|event| {
                if let PlanMidiEvent::NoteOn {
                    track_id,
                    channel,
                    key,
                    tick,
                    kit_element,
                    ..
                } = event
                {
                    let note = attacks
                        .get_mut(&(
                            track_indices[track_id.as_str()],
                            *channel,
                            *key,
                            tick.to_bits(),
                        ))?
                        .pop_front()?;
                    note_has_midi[note] = true;
                    note_kit[note] = *kit_element;
                    Some(MidiAttack {
                        program: note_programs[note],
                        recorded: selected[note].is_some(),
                    })
                } else {
                    None
                }
            })
            .collect();
        let midi_track: Vec<u16> = plan
            .midi
            .iter()
            .map(|event| track_indices[event.track_id()] as u16)
            .collect();
        let track_count = plan.tracks.len();
        for (track, channel) in tracks.iter_mut().zip(&mix.channels) {
            track.pan_after = channel.pan_after;
            track.pan_flat = channel.pan_flat;
            track.pan_flat_mix = if channel.pan_flat { 1.0 } else { 0.0 };
            track.pan_blend = if channel.pan_after { 1.0 } else { 0.0 };
            track.synth_centred = channel.pan_after;
        }
        let capacity = plan.notes.len().saturating_mul(3).max(8);
        let slots = (0..capacity).map(|_| None).collect();
        let scratch = vec![[0.0; 2]; plan.tracks.len() + 2];
        let kit_scratch = vec![[[0.0; 2]; KIT_ELEMENTS]; plan.tracks.len()];
        let mut renderer = Self {
            plan,
            timeline,
            fixed_timeline,
            _resources: resources,
            rate: sample_rate,
            tempo: RenderTempo::Relative { ratio: 1.0 },
            seconds: 0.0,
            clock_origin_seconds: 0.0,
            clock_origin_fixed_seconds: 0.0,
            clock_origin_tick: 0.0,
            clock_frames: 0,
            tracks,
            selected,
            midi_attacks,
            note_has_midi,
            note_kit,
            note_programs,
            note_end_ticks,
            slots,
            active: Vec::with_capacity(capacity),
            next_note: 0,
            dispatched_through: None,
            restrike_pending: false,
            next_midi: 0,
            midi_track,
            midi: None,
            midi_fade: vec![1.0; track_count],
            midi_fade_step: (1.0 / (f64::from(sample_rate) * 0.005)) as f32,
            parked_mix: None,
            mix,
            scratch,
            kit_scratch,
            backing: None,
            configured_backing: settings.backing.is_some(),
            tail: false,
            metronome: MetronomeSettings {
                enabled: false,
                volume: 0.4,
                visual: false,
                sound: Default::default(),
            },
            last_click: None,
            click: ClickVoice::new(sample_rate),
        };
        let d_max = renderer.plugin_delay_frames() as u64;
        if let Some(tap) = &mut renderer.midi {
            tap.set_delay_frames(d_max);
        }
        Ok(renderer)
    }
    fn spawn(
        &mut self,
        note: usize,
        track: usize,
        voice: SampleVoice,
        end_tick: f64,
        release: Option<VoiceSample>,
        unpitched: bool,
        drum: Option<RingingDrum>,
    ) {
        if let Some(slot) = self.slots.iter().position(Option::is_none) {
            self.slots[slot] = Some(ActiveVoice {
                note,
                track,
                channel: self.plan.notes[note].channel.unwrap_or(0),
                voice,
                end_tick,
                released: false,
                release,
                started_seconds: self.seconds,
                unpitched,
                drum,
            });
            self.active.push(slot);
        }
    }
    fn start_note(&mut self, index: usize) {
        let Some(selected) = self.selected[index].clone() else {
            return;
        };
        // A track routed to a MIDI port plays there, not here.
        if self
            .midi
            .as_ref()
            .is_some_and(|tap| tap.silences(selected.track))
        {
            return;
        }
        let note = &self.plan.notes[index];
        if let Some(origin) = selected.chain {
            if let Some(slot) = self.active.iter().copied().find(|&i| {
                self.slots[i].as_ref().is_some_and(|v| {
                    v.note == origin
                        && !v.unpitched
                        && v.voice.is_active()
                        && self.selected[origin]
                            .as_ref()
                            .is_some_and(|from| from.instrument == selected.instrument)
                })
            }) {
                let active = self.slots[slot].as_mut().unwrap();
                active.voice.transition(note.key, note.articulation);
                active.note = index;
                active.channel = note.channel.unwrap_or(0);
                active.end_tick = self.note_end_ticks[index];
                active.released = false;
                active.release = selected.release;
                return;
            }
        }
        if let Some(drum) = selected.drum {
            if drum.group != 0 {
                // A closed hi-hat stops the open one ringing: each voice this group cuts fades on its own release.
                for &slot in &self.active {
                    if let Some(active) = self.slots[slot].as_mut() {
                        if active.track == selected.track
                            && !active.released
                            && active
                                .drum
                                .is_some_and(|ringing| ringing.off_by == drum.group)
                        {
                            active.voice.release();
                            active.released = true;
                        }
                    }
                }
            }
            let sound = note.kit_sound.unwrap_or(note.key);
            // At most MAX_RINGING_STROKES of this sound ring on: fade the oldest, without allocating on the audio thread.
            loop {
                let mut count = 0;
                let mut oldest: Option<(f64, usize)> = None;
                for &slot in &self.active {
                    if let Some(active) = &self.slots[slot] {
                        if active.track == selected.track
                            && !active.released
                            && active.drum.is_some_and(|d| d.sound == sound)
                        {
                            count += 1;
                            if oldest.is_none_or(|(started, _)| active.started_seconds < started) {
                                oldest = Some((active.started_seconds, slot));
                            }
                        }
                    }
                }
                let (true, Some((_, slot))) = (count >= MAX_RINGING_STROKES, oldest) else {
                    break;
                };
                if let Some(active) = self.slots[slot].as_mut() {
                    active.voice.release();
                    active.released = true;
                }
            }
            // A drum is struck and rings out; only a choked cymbal stops when its note ends.
            let end = if drum.choke {
                self.note_end_ticks[index]
            } else {
                f64::INFINITY
            };
            let element = self.note_kit[index]
                .unwrap_or_else(|| gm_kit_element(note.key))
                .index();
            let voice = selected.attack.instantiate(self.rate);
            self.spawn(
                index,
                selected.track,
                voice,
                end,
                None,
                true,
                Some(RingingDrum {
                    element,
                    off_by: drum.off_by,
                    sound,
                }),
            );
            return;
        }
        // Striking a string again stops a palm mute still ringing on it.
        for &slot in &self.active {
            if let Some(active) = self.slots[slot].as_mut() {
                if active.track == selected.track
                    && active.drum.is_none()
                    && self.plan.notes[active.note].source.string == note.source.string
                {
                    active.voice.cut_ring();
                }
            }
        }
        let end = self.note_end_ticks[index];
        let mut voice = selected.attack.instantiate(self.rate);
        if selected.suppress_pick {
            voice.seek_elapsed_seconds(0.025, pitch_at(&note.pitch, note.start_tick));
        }
        self.spawn(
            index,
            selected.track,
            voice,
            end,
            selected.release,
            false,
            None,
        );
        if let Some(mut noise) = selected.noise {
            noise.parameters.gain_db -= 18.0;
            self.spawn(
                index,
                selected.track,
                noise.instantiate(self.rate),
                end,
                None,
                true,
                None,
            );
        }
    }
    fn gm_note_on(
        track: &mut Track,
        channel: u8,
        key: u8,
        velocity: u8,
        program: u8,
        element: Option<KitElement>,
    ) {
        let restore = track.channels[channel as usize].program as i32;
        let kit = track.kit_active;
        if let (true, Some(synths)) = (kit, &mut track.drum_synths) {
            let synth = &mut synths[element.unwrap_or_else(|| gm_kit_element(key)).index()];
            synth.process_midi_message(channel as i32, 0xc0, program as i32, 0);
            synth.note_on(channel as i32, key as i32, velocity as i32);
            synth.process_midi_message(channel as i32, 0xc0, restore, 0);
            track.drum_used = true;
        } else if let Some(synth) = &mut track.synth {
            synth.process_midi_message(channel as i32, 0xc0, program as i32, 0);
            synth.note_on(channel as i32, key as i32, velocity as i32);
            synth.process_midi_message(channel as i32, 0xc0, restore, 0);
        }
    }
    fn midi_event(track: &mut Track, event: &PlanMidiEvent, attack: Option<MidiAttack>) {
        match event {
            PlanMidiEvent::NoteOn {
                channel,
                key,
                velocity,
                kit_element,
                ..
            } => {
                if track.is_knock(*channel, attack) {
                    Self::gm_note_on(track, *channel, *key, *velocity, KNOCK_KIT, None);
                    return;
                }
                let program =
                    attack.map_or(track.channels[*channel as usize].program, |a| a.program);
                let recorded =
                    attack.map_or_else(|| track.recorded_program(program), |a| a.recorded);
                if !recorded {
                    Self::gm_note_on(track, *channel, *key, *velocity, program, *kit_element);
                }
            }
            PlanMidiEvent::NoteOff {
                channel,
                key,
                kit_element,
                ..
            } => {
                // A note may have started on either side of a kit change, and releasing a key nobody holds is harmless.
                if track.drum_used {
                    if let Some(synths) = &mut track.drum_synths {
                        let element = kit_element.unwrap_or_else(|| gm_kit_element(*key));
                        synths[element.index()].note_off(*channel as i32, *key as i32);
                    }
                }
                if let Some(synth) = &mut track.synth {
                    synth.note_off(*channel as i32, *key as i32);
                }
            }
            PlanMidiEvent::Program {
                channel, program, ..
            } => {
                if !track.locked {
                    track.channels[*channel as usize].program = *program;
                    if let Some(synths) = &mut track.drum_synths {
                        for synth in synths.iter_mut() {
                            synth.process_midi_message(*channel as i32, 0xc0, *program as i32, 0);
                        }
                    }
                    if let Some(synth) = &mut track.synth {
                        synth.process_midi_message(*channel as i32, 0xc0, *program as i32, 0);
                    }
                }
            }
            PlanMidiEvent::Controller {
                channel,
                controller,
                value,
                ..
            } => {
                let c = *channel as usize;
                match *controller {
                    7 => track.channels[c].volume = *value as f32 / 127.0,
                    11 => track.channels[c].expression = *value as f32 / 127.0,
                    10 => {
                        let pan = (*value as f64 - 64.0) / if *value < 64 { 64.0 } else { 63.0 };
                        let angle = (pan + 1.0) * std::f64::consts::FRAC_PI_4;
                        track.channels[c].pan = [
                            (angle.cos() * std::f64::consts::SQRT_2) as f32,
                            (angle.sin() * std::f64::consts::SQRT_2) as f32,
                        ];
                        track.pan = track.channels[c].pan;
                        track.pan_cc[c] = *value;
                    }
                    64 => track.channels[c].sustain = *value >= 64,
                    _ => {}
                }
                if *controller == 101 {
                    track.rpn_msb[c] = *value;
                }
                if *controller == 100 {
                    track.rpn_lsb[c] = *value;
                }
                if *controller == 6 && track.rpn_msb[c] == 0 && track.rpn_lsb[c] == 0 {
                    track.ranges[c] = (*value as f64).max(1.0);
                }
                // While the pan is after the board the synthesizers play at the centre, whatever the score says.
                let sent = if *controller == 10 && track.synth_centred {
                    64
                } else {
                    i32::from(*value)
                };
                if let Some(synths) = &mut track.drum_synths {
                    for synth in synths.iter_mut() {
                        synth.process_midi_message(*channel as i32, 0xb0, *controller as i32, sent);
                    }
                }
                if let Some(synth) = &mut track.synth {
                    synth.process_midi_message(*channel as i32, 0xb0, *controller as i32, sent);
                }
            }
            PlanMidiEvent::Bend { channel, value, .. }
            | PlanMidiEvent::NoteBend { channel, value, .. } => {
                let wheel = (8192.0 + *value / track.ranges[*channel as usize] * 8192.0)
                    .round()
                    .clamp(0.0, 16383.0) as i32;
                if let Some(synths) = &mut track.drum_synths {
                    for synth in synths.iter_mut() {
                        synth.process_midi_message(*channel as i32, 0xe0, wheel & 127, wheel >> 7);
                    }
                }
                if let Some(synth) = &mut track.synth {
                    synth.process_midi_message(*channel as i32, 0xe0, wheel & 127, wheel >> 7);
                }
            }
        }
    }
    fn frame(&mut self, end_tick: f64) -> ([f32; 2], Option<PulsePosition>) {
        let end_tick = self
            .plan
            .playback_end_tick
            .map_or(end_tick, |end| end.min(end_tick));
        let tick = self.timeline.seconds_to_tick(self.seconds);
        self.scratch.fill([0.0; 2]);
        self.kit_scratch.fill([[0.0; 2]; KIT_ELEMENTS]);
        if !self.tail
            && self
                .plan
                .playback_end_tick
                .is_some_and(|end| self.seconds >= self.timeline.tick_to_seconds(end))
        {
            return ([0.0; 2], None);
        }
        if let Some(tap) = &mut self.midi {
            tap.rendering();
            if tap.resync_due() {
                tap.resync(&self.plan.midi, &self.midi_track, self.next_midi);
            }
            if tap.remap_due() {
                tap.remap(&self.plan.midi, &self.midi_track, self.next_midi);
            }
        }
        if !self.tail {
            if self.restrike_pending {
                self.restrike_pending = false;
                self.restrike_held(tick, end_tick);
            }
            self.dispatched_through = Some(tick);
            while self.next_note < self.plan.notes.len()
                && self.plan.notes[self.next_note].start_tick <= tick + 1e-7
                && self.plan.notes[self.next_note].start_tick < end_tick
            {
                self.start_note(self.next_note);
                self.next_note += 1;
            }
            while self.next_midi < self.plan.midi.len()
                && self.plan.midi[self.next_midi].tick() <= tick + 1e-7
                && self.plan.midi[self.next_midi].tick() < end_tick
            {
                let event = &self.plan.midi[self.next_midi];
                if let Some(index) = self
                    .plan
                    .tracks
                    .iter()
                    .position(|t| t.id == event.track_id())
                {
                    let silenced = match &mut self.midi {
                        Some(tap) => {
                            tap.event(index, event);
                            tap.silences(index)
                        }
                        None => false,
                    };
                    // The internal synthesizer keeps the track's settings but strikes no note a port is playing.
                    if !(silenced && matches!(event, PlanMidiEvent::NoteOn { .. })) {
                        Self::midi_event(
                            &mut self.tracks[index],
                            event,
                            self.midi_attacks[self.next_midi],
                        );
                    }
                    // A track whose slot holds an instrument plays the plan's notes there, through the one seam
                    // (`NoteMap`). It follows the built-in sound: a track a port is playing strikes no note, here or on
                    // its instrument, and still releases the ones it has (a NoteOff the instrument does not hold is
                    // ignored by the insert). Mute and solo are gain after the board, so a muted track's instrument keeps
                    // its notes and is right at unmute. The kit mix shapes only the built-in stand-in.
                    if let Some(channel) = self.mix.channels.get_mut(index) {
                        // The map is borrowed, never copied: it is 256 bytes and this runs per event.
                        let note = channel.notes.as_ref().and_then(|map| map.note(event));
                        if let Some(note) = note {
                            if !(silenced && note.on) {
                                channel.dsp.stage_note(
                                    note.on,
                                    note.channel,
                                    note.key,
                                    note.velocity,
                                );
                            }
                        }
                    }
                }
                self.next_midi += 1;
            }
        }
        let pan_step = 100.0 / self.rate as f32;
        for track in &mut self.tracks {
            track.glide_pan(pan_step);
        }
        let mut index = 0;
        while index < self.active.len() {
            let slot = self.active[index];
            let voice = self.slots[slot].as_mut().unwrap();
            let mut release = None;
            if !voice.released && voice.end_tick <= tick + 1e-7 {
                voice.voice.release();
                voice.released = true;
                release = voice.release.take().map(|mut sample| {
                    sample.parameters.gain_db -=
                        sample.release_decay * (self.seconds - voice.started_seconds).max(0.0);
                    (voice.note, voice.track, sample)
                });
            }
            let pitch = if voice.unpitched {
                0.0
            } else {
                pitch_at(&self.plan.notes[voice.note].pitch, tick)
            };
            let frame = voice.voice.next_frame(pitch);
            let channel = &self.tracks[voice.track].channels[voice.channel as usize];
            // A track with a plug-in is panned after its board.
            let blend = self.tracks[voice.track].pan_blend;
            let sample = if blend == 0.0 {
                channel.process(frame)
            } else {
                channel.process_blended(frame, blend, self.tracks[voice.track].pan_flat_mix)
            };
            let out = match voice.drum {
                Some(drum) => &mut self.kit_scratch[voice.track][drum.element],
                None => &mut self.scratch[voice.track],
            };
            for c in 0..2 {
                out[c] += sample[c];
            }
            if !voice.voice.is_active() && (voice.released || voice.release.is_none()) {
                self.slots[slot] = None;
                self.active.swap_remove(index);
            } else {
                index += 1;
            }
            if let Some((note, track, sample)) = release {
                self.spawn(
                    note,
                    track,
                    sample.instantiate(self.rate),
                    f64::INFINITY,
                    None,
                    false,
                    None,
                );
            }
        }
        let bpm = match self.tempo {
            RenderTempo::Relative { ratio } => self.authored_bpm_at(tick) * ratio,
            RenderTempo::Fixed { bpm } => bpm,
        };
        // A plug-in hears the frame's tempo, meter and place (preflight ruling P11); without one, only the tempo is
        // needed, and nothing more is worked out.
        let context = self
            .mix
            .channels
            .iter()
            .any(|channel| channel.dsp.has_plugin())
            .then(|| {
                let (sig_num, sig_den) = self.meter_at(tick);
                FrameContext {
                    bpm,
                    sig_num: sig_num.min(u16::MAX as u32) as u16,
                    sig_den: sig_den.min(u16::MAX as u32) as u16,
                    playing: true,
                    project_frame: (self.seconds * self.rate as f64).round() as i64,
                    project_quarters: tick / self.plan.ppq.max(1) as f64,
                }
            });
        for (index, track) in self.tracks.iter_mut().enumerate() {
            // A synthesizer told the centre plays the pan the voices keep (`synth_factors`); one that pans itself, as it is.
            let synth_pan = track.synth_factors();
            if let Some(synth) = &mut track.synth {
                let mut left = [0.0];
                let mut right = [0.0];
                synth.render(&mut left, &mut right);
                self.scratch[index][0] += left[0] * synth_pan[0];
                self.scratch[index][1] += right[0] * synth_pan[1];
            }
            if let Some(synths) = &mut track.drum_synths {
                // The ramp moves with the clock, struck or not, so a note struck after a change starts at the new level.
                track.kit_rendered = true;
                let gains = self.mix.channels[index].kit.step();
                // Recorded drum voices take the same element mix as the General MIDI kit.
                for (voices, gain) in self.kit_scratch[index].iter().zip(gains) {
                    self.scratch[index][0] += voices[0] * gain[0];
                    self.scratch[index][1] += voices[1] * gain[1];
                }
                if track.drum_used {
                    for (synth, gain) in synths.iter_mut().zip(gains) {
                        let mut left = [0.0];
                        let mut right = [0.0];
                        synth.render(&mut left, &mut right);
                        self.scratch[index][0] += left[0] * gain[0] * synth_pan[0];
                        self.scratch[index][1] += right[0] * gain[1] * synth_pan[1];
                    }
                }
            }
            let channel = &mut self.mix.channels[index];
            // The score's pan places what the plug-in makes, as it stood when that entered the plug-in.
            track.step_pan(channel.dsp.plugin_delay());
            channel.dsp.set_insert_pan(track.pan_after_factors());
            let board = match &context {
                Some(context) if channel.dsp.has_plugin() => {
                    channel.dsp.process_at(self.scratch[index], context)
                }
                _ => channel.dsp.process(self.scratch[index], bpm),
            };
            self.scratch[index] = channel.gain.process(board);
            let routed = self.midi.as_ref().is_some_and(|tap| tap.silences(index));
            let fade = &mut self.midi_fade[index];
            let target = if routed { 0.0 } else { 1.0 };
            if *fade != target {
                *fade = if routed {
                    (*fade - self.midi_fade_step).max(0.0)
                } else {
                    (*fade + self.midi_fade_step).min(1.0)
                };
            }
            if *fade != 1.0 {
                let gain = *fade;
                self.scratch[index] =
                    [self.scratch[index][0] * gain, self.scratch[index][1] * gain];
            }
            if let Some(comp) = &mut self.mix.compensation {
                self.scratch[index] = comp.track(index, self.scratch[index]);
            }
        }
        let backing_index = self.plan.tracks.len();
        if let Some(backing) = &mut self.backing {
            if !self.tail {
                self.scratch[backing_index] =
                    self.mix.backing.process(backing.next_frame(self.seconds));
            }
        }
        if let Some(comp) = &mut self.mix.compensation {
            self.scratch[backing_index] = comp.backing(self.scratch[backing_index]);
        }
        let mut pulse = None;
        if self.metronome.enabled || self.metronome.visual {
            let (beat, pulse_tick, accent) = self.beat_grid(tick);
            if Some(beat) != self.last_click
                && pulse_tick < end_tick
                && !self.tail
                && self.seconds < self.plan.duration_ms / 1000.0
            {
                self.last_click = Some(beat);
                self.click.trigger(accent, self.metronome.sound);
                pulse = Some(PulsePosition {
                    beat: beat.1 as u32,
                    beats_per_bar: self.meter_at(tick).0,
                    accent,
                });
            }
            let click = self.click.frame(if self.metronome.enabled {
                self.metronome.volume
            } else {
                0.0
            });
            let click_in = if self.metronome.enabled {
                [click; 2]
            } else {
                [0.0; 2]
            };
            let click_out = match &mut self.mix.compensation {
                Some(comp) => comp.click(click_in),
                None => click_in,
            };
            let click_index = backing_index + usize::from(self.backing.is_some());
            if self.metronome.enabled || click_out != [0.0; 2] {
                self.scratch[click_index] = click_out;
            }
        }
        if let Some(comp) = &mut self.mix.compensation {
            if !self.metronome.enabled && !self.metronome.visual {
                comp.click([0.0; 2]);
            }
        }
        // The tracks and backing go through the master's effects and level. The metronome is added after them, so
        // the click is neither coloured nor turned with the music, and the limiter sees all of it. Adding the click
        // last keeps the sum in the order it always had.
        let program = self.plan.tracks.len() + usize::from(self.backing.is_some());
        let mut sum = [0.0; 2];
        for sample in self.scratch.iter().take(program) {
            for c in 0..2 {
                sum[c] += sample[c];
            }
        }
        sum = self.mix.master.bus(sum, bpm);
        for sample in self.scratch.iter().take(self.stem_count()).skip(program) {
            for c in 0..2 {
                sum[c] += sample[c];
            }
        }
        sum = self.mix.master.limit(sum);
        self.clock_frames += 1;
        self.seconds = match self.tempo {
            RenderTempo::Relative { ratio } => {
                self.clock_origin_seconds + self.clock_frames as f64 * ratio / self.rate as f64
            }
            RenderTempo::Fixed { bpm } => {
                if !self.fixed_timeline.is_empty() {
                    let wall = self.clock_origin_fixed_seconds
                        + self.clock_frames as f64 / self.rate as f64;
                    self.timeline
                        .tick_to_seconds(self.fixed_timeline.seconds_to_tick(wall))
                } else {
                    self.timeline.tick_to_seconds(
                        self.clock_origin_tick
                            + self.clock_frames as f64 * bpm * self.plan.ppq as f64
                                / (60.0 * self.rate as f64),
                    )
                }
            }
        };
        if !self.tail {
            if let Some(end) = self.plan.playback_end_tick {
                self.seconds = self.seconds.min(self.timeline.tick_to_seconds(end));
            }
        }
        (sum.map(master_limit), pulse)
    }
    fn status(
        &self,
        frames: usize,
        pulse_count: u32,
        last_pulse: Option<PulsePosition>,
    ) -> RenderStatus {
        RenderStatus {
            frames,
            tick: self
                .plan
                .playback_end_tick
                .filter(|&end| !self.tail && self.seconds >= self.timeline.tick_to_seconds(end))
                .unwrap_or_else(|| self.timeline.seconds_to_tick(self.seconds)),
            seconds: self.seconds,
            ended: self.tail || self.seconds + 1e-9 >= self.duration_seconds(),
            pulse_count,
            last_pulse,
        }
    }
    pub fn render_into(&mut self, output: &mut [[f32; 2]]) -> RenderStatus {
        self.render_with_ceiling(output, f64::INFINITY)
    }
    /// Render only sample starts before an exclusive musical endpoint. The strict
    /// event ceiling is independent of the near-tick dispatch tolerance.
    pub fn render_until(&mut self, output: &mut [[f32; 2]], end_tick: f64) -> RenderStatus {
        let frames = output.len().min(self.output_frames_until(end_tick));
        output[frames..].fill([0.0; 2]);
        self.render_with_ceiling(&mut output[..frames], end_tick)
    }
    fn render_with_ceiling(&mut self, output: &mut [[f32; 2]], end_tick: f64) -> RenderStatus {
        let mut pulse_count: u32 = 0;
        let mut last_pulse = None;
        for chunk in output.chunks_mut(512) {
            for sample in chunk {
                let (value, pulse) = self.frame(end_tick);
                if let Some(tap) = &mut self.midi {
                    tap.advance_cursor();
                }
                *sample = value;
                if pulse.is_some() {
                    pulse_count = pulse_count.saturating_add(1);
                    last_pulse = pulse;
                }
            }
        }
        self.status(output.len(), pulse_count, last_pulse)
    }
    pub fn render_stems_into(&mut self, outputs: &mut [&mut [[f32; 2]]]) -> RenderStatus {
        let frames = outputs.iter().map(|o| o.len()).min().unwrap_or(0);
        let mut pulse_count: u32 = 0;
        let mut last_pulse = None;
        for frame in 0..frames {
            let (_, pulse) = self.frame(f64::INFINITY);
            if let Some(tap) = &mut self.midi {
                tap.advance_cursor();
            }
            if pulse.is_some() {
                pulse_count = pulse_count.saturating_add(1);
                last_pulse = pulse;
            }
            for (channel, output) in outputs.iter_mut().enumerate() {
                output[frame] = self.scratch.get(channel).copied().unwrap_or([0.0; 2]);
            }
        }
        self.status(frames, pulse_count, last_pulse)
    }
    pub fn render_stems_and_mix_into(
        &mut self,
        outputs: &mut [&mut [[f32; 2]]],
        mix: &mut [[f32; 2]],
    ) -> RenderStatus {
        self.render_stems_and_mix_until(outputs, mix, f64::INFINITY)
    }
    pub fn render_stems_and_mix_until(
        &mut self,
        outputs: &mut [&mut [[f32; 2]]],
        mix: &mut [[f32; 2]],
        end_tick: f64,
    ) -> RenderStatus {
        let frames = outputs
            .iter()
            .map(|o| o.len())
            .min()
            .unwrap_or(mix.len())
            .min(mix.len());
        let mut pulse_count: u32 = 0;
        let mut last_pulse = None;
        for frame in 0..frames {
            let (value, pulse) = self.frame(end_tick);
            if let Some(tap) = &mut self.midi {
                tap.advance_cursor();
            }
            mix[frame] = value;
            if pulse.is_some() {
                pulse_count = pulse_count.saturating_add(1);
                last_pulse = pulse;
            }
            for (channel, output) in outputs.iter_mut().enumerate() {
                output[frame] = self.scratch.get(channel).copied().unwrap_or([0.0; 2]);
            }
        }
        self.status(frames, pulse_count, last_pulse)
    }
    pub fn seek_tick(&mut self, tick: f64) {
        self.seek_tick_internal(tick, false, None, false);
    }
    /// A loop wrap: repositions playback, but keeps inserts, compensation lines and master bus continuous.
    pub fn wrap_to_tick(&mut self, tick: f64) {
        self.seek_tick_internal(tick, true, None, false);
    }
    /// An edit while playing: this renderer takes over from `old` at `tick`, the tick of the next frame to render, as
    /// [`wrap_to_tick`](Self::wrap_to_tick) and [`continue_from`](Self::continue_from) do, and also dispatches what
    /// `old` has not: an event after `old`'s last frame and before `tick` is dispatched here, on the first frame,
    /// instead of by neither (a note or MIDI event is struck once across the hand-over). What `old` dispatched is
    /// reconstructed as before.
    pub fn hand_over_from(&mut self, tick: f64, old: &mut Renderer) {
        self.seek_tick_internal(tick, true, old.dispatched_through, true);
        self.continue_from(old);
        // A strike the old renderer had not yet sent is still owed, to the instrument that carries on, under this plan.
        self.restrike_pending = old.restrike_pending;
    }
    fn seek_tick_internal(
        &mut self,
        tick: f64,
        is_wrap: bool,
        through: Option<f64>,
        hand_over: bool,
    ) {
        // With no plug-in, a wrap is the seek it was before plug-ins, so playback and export stay bit-identical.
        let is_wrap = is_wrap && self.plugins_active();
        let tick = if tick.is_finite() {
            tick.clamp(0.0, self.duration_tick())
        } else {
            0.0
        };
        if let Some(tap) = &mut self.midi {
            tap.on_seek();
        }
        self.seconds = self.timeline.tick_to_seconds(tick);
        self.reset_clock_origin();
        self.tail = false;
        for slot in &mut self.slots {
            *slot = None;
        }
        self.active.clear();
        for channel in &mut self.mix.channels {
            if is_wrap {
                channel.dsp.reset_for_wrap();
                // The insert keeps streaming through a wrap, so what an instrument holds would ring on into the next pass.
                if channel.notes.is_some() {
                    channel.dsp.all_notes_off();
                }
            } else {
                channel.dsp.reset();
            }
        }
        // Everything sounding is cut, so nothing needs the old level to fade from, and held notes struck again below
        // already go where the effective kit sends them.
        for track in &mut self.tracks {
            track.kit_rendered = false;
        }
        self.settle_idle_kit();
        if !is_wrap {
            self.mix.master.reset();
            if let Some(comp) = &mut self.mix.compensation {
                comp.flush();
            }
        }
        // A hand-over starts after what the old renderer dispatched, not at `tick`: the frames it rendered saw events up to
        // its last frame's tick, and the first frame here sees those up to `tick`.
        let through = through.filter(|through| through.is_finite() && *through < tick);
        // Carried on, so a second hand-over before any frame is rendered still starts after what the first renderer
        // dispatched: this renderer has dispatched nothing since, and the gap after that frame is still open. A plain seek
        // or a wrap passes none and resets it.
        self.dispatched_through = through;
        self.next_note = match through {
            Some(through) => self
                .plan
                .notes
                .partition_point(|n| n.start_tick <= through + 1e-7),
            None => self.plan.notes.partition_point(|n| n.start_tick < tick),
        };
        self.next_midi = match through {
            Some(through) => self
                .plan
                .midi
                .partition_point(|m| m.tick() <= through + 1e-7),
            None => self.plan.midi.partition_point(|m| m.tick() < tick),
        };
        for (track_index, track) in self.tracks.iter_mut().enumerate() {
            let start_programs = track.start_programs;
            track.channels = std::array::from_fn(|c| MidiChannel::new(start_programs[c]));
            track.pan = [1.0; 2];
            track.pan_cc = [64; 16];
            // Everything sounding is cut, so the pan has nothing to glide for: it is where the board puts it.
            track.settle_pan();
            track.drum_used = false;
            track.kit_rendered = false;
            if let Some(synths) = &mut track.drum_synths {
                for synth in synths.iter_mut() {
                    synth.reset();
                    for channel in 0..16 {
                        synth.process_midi_message(
                            channel,
                            0xc0,
                            start_programs[channel as usize] as i32,
                            0,
                        );
                    }
                }
            }
            if let Some(synth) = &mut track.synth {
                synth.reset();
                for channel in 0..16 {
                    synth.process_midi_message(
                        channel,
                        0xc0,
                        start_programs[channel as usize] as i32,
                        0,
                    );
                }
            }
            track.ranges = [2.0; 16];
            track.rpn_msb = [127; 16];
            track.rpn_lsb = [127; 16];
            let mut held = [[0u8; 128]; 16];
            let mut sustained = [[false; 128]; 16];
            let mut velocities = [[0u8; 128]; 16];
            let mut programs = [[0u8; 128]; 16];
            let mut elements = [[None::<KitElement>; 128]; 16];
            for (event_index, event) in self
                .plan
                .midi
                .iter()
                .take(self.next_midi)
                .enumerate()
                .filter(|(_, e)| e.track_id() == self.plan.tracks[track_index].id)
            {
                match event {
                    PlanMidiEvent::NoteOn {
                        channel,
                        key,
                        velocity,
                        kit_element,
                        ..
                    } => {
                        let c = *channel as usize;
                        let k = *key as usize;
                        // A knock is a one-shot tap: a seek into its few milliseconds does not strike it again.
                        if self.midi_attacks[event_index].is_none()
                            && !track.is_knock(*channel, None)
                            && !track.recorded_program(track.channels[c].program)
                        {
                            held[c][k] = held[c][k].saturating_add(1);
                            velocities[c][k] = *velocity;
                            programs[c][k] = track.channels[c].program;
                            elements[c][k] = *kit_element;
                        }
                    }
                    PlanMidiEvent::NoteOff { channel, key, .. } => {
                        let c = *channel as usize;
                        let k = *key as usize;
                        if held[c][k] > 0 {
                            held[c][k] -= 1;
                            sustained[c][k] = track.channels[c].sustain;
                        }
                    }
                    _ => {
                        Self::midi_event(track, event, None);
                        if let PlanMidiEvent::Controller {
                            channel,
                            controller: 64,
                            value,
                            ..
                        } = event
                        {
                            if *value < 64 {
                                sustained[*channel as usize].fill(false);
                            }
                        }
                    }
                }
            }
            let routed = self
                .midi
                .as_ref()
                .is_some_and(|tap| tap.silences(track_index));
            for c in 0..16 {
                for key in 0..128 {
                    if !routed && (held[c][key] > 0 || sustained[c][key]) {
                        Self::gm_note_on(
                            track,
                            c as u8,
                            key as u8,
                            velocities[c][key],
                            programs[c][key],
                            elements[c][key],
                        );
                    }
                }
            }
        }
        // A hosted instrument is struck again for each key the plan holds at this position, as the built-in kit's held notes
        // are above, but with the first frame rendered here (`restrike_held`), not now: a count-in runs the inserts before
        // that frame and would send the strikes at its start. A hand-over is not a new position: the running instrument
        // keeps its keys and `continue_from` fixes them up, and this renderer's insert may not even be the one that carries
        // on, so it asks for no strike.
        if !hand_over {
            self.restrike_pending = true;
        }
        for index in 0..self.next_note {
            if self.note_end_ticks[index] > tick {
                self.start_note(index);
                if let Some(slot) = self.active.iter().copied().find(|&i| {
                    self.slots[i]
                        .as_ref()
                        .is_some_and(|v| v.note == index && !v.unpitched)
                }) {
                    let note = &self.plan.notes[index];
                    let elapsed = match self.tempo {
                        RenderTempo::Relative { ratio } => {
                            (self.seconds - self.timeline.tick_to_seconds(note.start_tick)) / ratio
                        }
                        RenderTempo::Fixed { bpm } => {
                            if !self.fixed_timeline.is_empty() {
                                self.fixed_timeline.tick_to_seconds(tick)
                                    - self.fixed_timeline.tick_to_seconds(note.start_tick)
                            } else {
                                (tick - note.start_tick) * 60.0 / (bpm * self.plan.ppq as f64)
                            }
                        }
                    };
                    self.slots[slot]
                        .as_mut()
                        .unwrap()
                        .voice
                        .seek_elapsed_seconds(elapsed, pitch_at(&note.pitch, tick));
                } else if self.selected[index].is_none()
                    && self.note_has_midi[index]
                    && !self.midi_silences(self.plan.notes[index].source.target.track as usize)
                {
                    let note = &self.plan.notes[index];
                    Self::gm_note_on(
                        &mut self.tracks[note.source.target.track as usize],
                        note.channel.unwrap_or(0),
                        note.key,
                        note.velocity,
                        self.note_programs[index],
                        self.note_kit[index],
                    );
                }
            }
        }
        if let Some(backing) = &mut self.backing {
            backing.seek(self.seconds);
        }
        self.reset_click_position();
    }
    /// Routes tracks to MIDI ports, replacing any earlier routing. The tap is built off the audio thread; what comes back
    /// (the earlier one) is dropped off it too. Notes the earlier routing had sounding are released first.
    pub fn replace_midi(&mut self, mut tap: Box<MidiTap>) -> Option<Box<MidiTap>> {
        if tap.track_count() != self.tracks.len() {
            return Some(tap);
        }
        let mut old = self.midi.take();
        tap.adopt(old.as_deref_mut());
        let d_max = self.plugin_delay_frames() as u64;
        tap.set_delay_frames(d_max);
        self.midi = Some(tap);
        old
    }
    /// The MIDI routing, where there is any.
    pub fn midi_tap(&mut self) -> Option<&mut MidiTap> {
        self.midi.as_deref_mut()
    }
    /// Says which output frame the next rendered frame is, on the stream's count, so its MIDI messages are stamped.
    pub fn midi_set_cursor(&mut self, frame: u64) {
        if let Some(tap) = &mut self.midi {
            tap.set_cursor(frame);
        }
    }
    /// Whether `track` plays on a MIDI port and is silent here.
    pub fn midi_silences(&self, track: usize) -> bool {
        self.midi.as_ref().is_some_and(|tap| tap.silences(track))
    }
    pub fn set_speed(&mut self, speed: f64) -> Result<(), String> {
        self.set_practice_tempo(RenderTempo::Relative { ratio: speed })
    }
    pub fn set_practice_tempo(&mut self, tempo: RenderTempo) -> Result<(), String> {
        self.apply_practice_tempo(tempo)
            .map_err(PracticeRefusal::message)
    }
    /// As `set_practice_tempo`, deciding a refusal without building a message: the audio thread uses this one, and
    /// nothing on it may allocate.
    pub fn apply_practice_tempo(&mut self, tempo: RenderTempo) -> Result<(), PracticeRefusal> {
        match tempo {
            RenderTempo::Relative { ratio }
                if !ratio.is_finite() || !(0.1..=3.0).contains(&ratio) =>
            {
                return Err(PracticeRefusal::Fixed(
                    "Practice speed must be between 10% and 300%.",
                ));
            }
            RenderTempo::Fixed { bpm } => {
                if !bpm.is_finite() || !(10.0..=300.0).contains(&bpm) {
                    return Err(PracticeRefusal::Fixed(
                        "Fixed tempo must be between 10 and 300 BPM.",
                    ));
                }
                if let Some(authored) = self.authored_tempos() {
                    authored.refuse_fixed(bpm)?;
                }
            }
            _ => {}
        }
        if self.tempo != tempo {
            self.tempo = tempo;
            if let RenderTempo::Fixed { bpm } = tempo {
                if let Some(fermatas) = self.plan.fermatas.as_deref() {
                    self.fixed_timeline
                        .rebuild_fixed(bpm, self.plan.ppq, fermatas);
                }
            }
            self.reset_clock_origin();
        }
        Ok(())
    }
    fn reset_clock_origin(&mut self) {
        self.clock_origin_seconds = self.seconds;
        self.clock_origin_tick = self.timeline.seconds_to_tick(self.seconds);
        self.clock_origin_fixed_seconds = if !self.fixed_timeline.is_empty() {
            self.fixed_timeline.tick_to_seconds(self.clock_origin_tick)
        } else {
            0.0
        };
        self.clock_frames = 0;
    }
    pub fn output_frames_until(&self, end_tick: f64) -> usize {
        let end_tick = self
            .plan
            .playback_end_tick
            .map_or(end_tick, |end| end.min(end_tick));
        let tick = self.timeline.seconds_to_tick(self.seconds);
        let frames = match self.tempo {
            RenderTempo::Relative { ratio } => {
                (self.timeline.tick_to_seconds(end_tick) - self.seconds) * self.rate as f64 / ratio
            }
            RenderTempo::Fixed { bpm } => {
                if !self.fixed_timeline.is_empty() {
                    (self.fixed_timeline.tick_to_seconds(end_tick)
                        - self.fixed_timeline.tick_to_seconds(tick))
                        * self.rate as f64
                } else {
                    (end_tick - tick) * 60.0 * self.rate as f64 / (bpm * self.plan.ppq as f64)
                }
            }
        };
        if frames <= 0.0 {
            0
        } else {
            (frames - 1e-7).ceil().max(1.0) as usize
        }
    }
    pub fn authored_bpm_at(&self, tick: f64) -> f64 {
        let index = self
            .plan
            .tempos
            .partition_point(|tempo| tempo.tick <= tick)
            .saturating_sub(1);
        self.plan.tempos[index].bpm
    }
    pub fn meter_at(&self, tick: f64) -> (u32, u32) {
        let index = self
            .plan
            .occurrences
            .partition_point(|measure| measure.start_tick <= tick + 1e-7)
            .saturating_sub(1);
        self.plan.occurrences.get(index).map_or((4, 4), |measure| {
            (measure.meter_numerator, measure.meter_denominator)
        })
    }
    /// Delay in frames from plug-in compensation: `D_max`, or 0 without plug-ins.
    pub fn plugin_delay_frames(&self) -> usize {
        self.mix.compensation.as_ref().map_or(0, |c| c.d_max())
    }
    /// Whether a plug-in insert, or a compensation still gliding after the last one left, is active. Only then does a
    /// wrap keep the inserts, the compensation lines and the master bus streaming; otherwise it is a plain seek.
    pub fn plugins_active(&self) -> bool {
        self.mix.channels.iter().any(|c| c.dsp.has_plugin()) || self.compensation_active()
    }
    fn compensation_active(&self) -> bool {
        self.mix.compensation.as_ref().is_some_and(|c| c.active())
    }
    /// The strikes per channel and key that the plan holds at `next_midi` for track `track_index` once `map` has turned each
    /// note into the key an instrument gets: every NoteOn before it and not yet ended, counted by the key actually sent. A
    /// sound the map leaves silent is held nowhere. The events of the track are found by the track index the renderer worked
    /// out for each at build time, so no string is compared on the audio thread. Does not allocate.
    fn held_wanted(
        midi: &[PlanMidiEvent],
        midi_track: &[u16],
        next_midi: usize,
        track_index: usize,
        map: &NoteMap,
    ) -> [[u8; 128]; 16] {
        Self::held_strikes(midi, midi_track, next_midi, track_index, map, None).0
    }
    /// [`held_wanted`](Self::held_wanted), and with it the velocity of the last strike of each key the plan holds, which a
    /// seek, a wrap or an export's start strikes the key again at. A key counts as held only if it is still held once the
    /// NoteOffs the first frame dispatches have been applied: with `first_frame` (that frame's tick and end tick), a NoteOff
    /// of the track at a tick up to the frame's tick plus the dispatch tolerance (and before its end) ends a strike here as
    /// it will there, so a key that ends exactly where the position begins is not struck only to be released at once. A
    /// key that is held keeps all its strikes counted, for those NoteOffs to leave the rest. Does not allocate.
    fn held_strikes(
        midi: &[PlanMidiEvent],
        midi_track: &[u16],
        next_midi: usize,
        track_index: usize,
        map: &NoteMap,
        first_frame: Option<(f64, f64)>,
    ) -> ([[u8; 128]; 16], [[u8; 128]; 16]) {
        let mut wanted = [[0u8; 128]; 16];
        let mut velocities = [[0u8; 128]; 16];
        let count = |wanted: &mut [[u8; 128]; 16],
                     velocities: Option<&mut [[u8; 128]; 16]>,
                     event: &PlanMidiEvent| {
            let Some(note) = map.note(event) else {
                return;
            };
            let Some(held) = wanted
                .get_mut(usize::from(note.channel))
                .and_then(|row| row.get_mut(usize::from(note.key)))
            else {
                return;
            };
            if note.on && note.velocity > 0 {
                *held = held.saturating_add(1);
                if let Some(velocity) = velocities
                    .and_then(|v| v.get_mut(usize::from(note.channel)))
                    .and_then(|row| row.get_mut(usize::from(note.key)))
                {
                    *velocity = note.velocity;
                }
            } else {
                *held = held.saturating_sub(1);
            }
        };
        for event in midi
            .iter()
            .zip(midi_track)
            .take(next_midi)
            .filter(|(_, owner)| usize::from(**owner) == track_index)
            .map(|(event, _)| event)
        {
            count(&mut wanted, Some(&mut velocities), event);
        }
        if let Some((tick, end_tick)) = first_frame {
            // What the first frame dispatches next, in plan order, as the frame's own loop selects it. Only the ends are
            // applied: its NoteOns are the frame's to send.
            let mut after = wanted;
            for event in midi
                .iter()
                .zip(midi_track)
                .skip(next_midi)
                .take_while(|(event, _)| event.tick() <= tick + 1e-7 && event.tick() < end_tick)
                .filter(|(_, owner)| usize::from(**owner) == track_index)
                .map(|(event, _)| event)
            {
                if map.note(event).is_some_and(|n| n.on && n.velocity > 0) {
                    continue;
                }
                count(&mut after, None, event);
            }
            for (row, left) in wanted.iter_mut().zip(&after) {
                for (held, left) in row.iter_mut().zip(left) {
                    if *left == 0 {
                        *held = 0;
                    }
                }
            }
        }
        (wanted, velocities)
    }
    /// Strikes each hosted instrument for the keys the plan holds at the position a seek, a wrap or an export's start has
    /// put the renderer at (`restrike_pending`), on the frame about to be rendered, before its events are dispatched. A track
    /// a port plays strikes none. Does not allocate.
    fn restrike_held(&mut self, tick: f64, end_tick: f64) {
        for (track_index, channel) in self.mix.channels.iter_mut().enumerate() {
            let Some(map) = channel.notes.as_ref() else {
                continue;
            };
            // A track a port plays strikes no note, here or on its instrument.
            if self
                .midi
                .as_ref()
                .is_some_and(|tap| tap.silences(track_index))
            {
                continue;
            }
            let (strikes, velocities) = Self::held_strikes(
                &self.plan.midi,
                &self.midi_track,
                self.next_midi,
                track_index,
                map,
                Some((tick, end_tick)),
            );
            for (c, row) in strikes.iter().enumerate() {
                for (key, &held) in row.iter().enumerate() {
                    if held > 0 {
                        channel
                            .dsp
                            .restrike_note(c as u8, key as u8, velocities[c][key], held);
                    }
                }
            }
        }
    }
    /// An edit while playing: this renderer replaces `old` at the same place. It takes over `old`'s plug-in inserts and
    /// compensation lines the way a mix change does, so the plug-in tracks and the delayed stems keep streaming instead
    /// of dropping D frames. Lines and inserts pair by position, so a renderer for other tracks, or the same tracks in
    /// another order, takes over nothing and starts as a plain install. Moves buffers; does not allocate. `old` is
    /// retired off the audio thread with whatever it keeps.
    pub fn continue_from(&mut self, old: &mut Renderer) {
        let same_tracks = self.plan.tracks.len() == old.plan.tracks.len()
            && self
                .plan
                .tracks
                .iter()
                .zip(&old.plan.tracks)
                .all(|(new, old)| new.id == old.id);
        if self.rate != old.rate
            || !same_tracks
            || self.mix.channels.len() != old.mix.channels.len()
        {
            return;
        }
        let old_sounding = old.mix.channels.iter().any(|c| c.dsp.sounding());
        for (new, old) in self.mix.channels.iter_mut().zip(&mut old.mix.channels) {
            new.dsp.continue_plugin_from(&mut old.dsp);
        }
        // What the old renderer's plug-ins still have in flight was placed by its pan, so the pan carries on from where it
        // stood, glide and moves held back by the plug-in's delay included.
        for (new, old) in self.tracks.iter_mut().zip(&old.tracks) {
            new.pan_blend = old.pan_blend;
            new.pan_flat_mix = old.pan_flat_mix;
            new.pan_late = old.pan_late;
            new.pan_seen = old.pan_seen;
            new.pan_queue = old.pan_queue;
            new.pan_queued = old.pan_queued;
            new.sync_synth_pan();
        }
        // The running instrument comes with the notes the old plan had it hold. The edit may have deleted, moved or
        // re-pitched one of them, whose NoteOff would then never come: the instrument keeps exactly the keys the new
        // plan holds at this tick (those struck before it and not ended), and ends the rest.
        let track_count = self.plan.tracks.len();
        for (track_index, channel) in self.mix.channels.iter_mut().enumerate().take(track_count) {
            let Some(map) = channel.notes.as_ref() else {
                continue;
            };
            let wanted = Self::held_wanted(
                &self.plan.midi,
                &self.midi_track,
                self.next_midi,
                track_index,
                map,
            );
            channel.dsp.retain_notes(&wanted);
        }
        carry_compensation(
            &mut self.mix.compensation,
            &mut old.mix.compensation,
            old_sounding,
        );
        let d_max = self.plugin_delay_frames() as u64;
        if let Some(tap) = &mut self.midi {
            tap.set_delay_frames(d_max);
        }
    }
    /// Attaches an insert to track `track` and updates delay compensation.
    pub fn attach_plugin(&mut self, track: usize, insert: Box<PluginInsert>) {
        self.mix.attach_plugin(track, insert);
        // Before anything plays, so the pan is where the insert puts it from the first frame.
        if let (Some(channel), Some(track)) =
            (self.mix.channels.get(track), self.tracks.get_mut(track))
        {
            track.set_pan_after(channel.pan_after, channel.pan_flat);
            track.settle_pan();
        }
    }
    /// The tracks whose plug-in insert this renderer's mix refused, and why.
    pub fn plugin_refusals(&self) -> &[(String, InsertError)] {
        self.mix.plugin_refusals()
    }
    /// Whether any attached plug-in has faulted.
    pub fn plugin_faulted(&self) -> bool {
        self.mix.channels.iter().any(|c| c.dsp.plugin_faulted())
    }
    /// Advances plug-in inserts and compensation lines with silent input during a count-in,
    /// returning the delayed audio and click. With no compensation, returns `[click, click]`.
    pub fn count_in_frame(&mut self, click: f32) -> [f32; 2] {
        if !self.compensation_active() {
            return [click, click];
        }
        let tick = self.timeline.seconds_to_tick(self.seconds);
        let bpm = match self.tempo {
            RenderTempo::Relative { ratio } => self.authored_bpm_at(tick) * ratio,
            RenderTempo::Fixed { bpm } => bpm,
        };
        let (sig_num, sig_den) = self.meter_at(tick);
        let comp = self.mix.compensation.as_mut().unwrap();
        let context = FrameContext {
            bpm,
            sig_num: sig_num.min(u16::MAX as u32) as u16,
            sig_den: sig_den.min(u16::MAX as u32) as u16,
            playing: false,
            project_frame: (self.seconds * self.rate as f64).round() as i64,
            project_quarters: tick / self.plan.ppq.max(1) as f64,
        };
        for (index, channel) in self.mix.channels.iter_mut().enumerate() {
            let pan = self.tracks.get_mut(index).map_or([1.0; 2], |track| {
                track.step_pan(channel.dsp.plugin_delay());
                track.pan_after_factors()
            });
            channel.dsp.set_insert_pan(pan);
            let board = if channel.dsp.has_plugin() {
                channel.dsp.process_at([0.0; 2], &context)
            } else {
                channel.dsp.process([0.0; 2], bpm)
            };
            let mut gained = channel.gain.process(board);
            // A track sent to a MIDI port stays silent here too, as in a played frame.
            let routed = self.midi.as_ref().is_some_and(|tap| tap.silences(index));
            if let Some(fade) = self.midi_fade.get_mut(index) {
                *fade = if routed {
                    (*fade - self.midi_fade_step).max(0.0)
                } else {
                    (*fade + self.midi_fade_step).min(1.0)
                };
                if *fade != 1.0 {
                    gained = [gained[0] * *fade, gained[1] * *fade];
                }
            }
            self.scratch[index] = comp.track(index, gained);
        }
        let backing_index = self.plan.tracks.len();
        self.scratch[backing_index] = comp.backing([0.0; 2]);
        let click_index = backing_index + usize::from(self.backing.is_some());
        self.scratch[click_index] = comp.click([click; 2]);

        let program = self.plan.tracks.len() + usize::from(self.backing.is_some());
        let mut sum = [0.0; 2];
        for sample in self.scratch.iter().take(program) {
            for c in 0..2 {
                sum[c] += sample[c];
            }
        }
        sum = self.mix.master.bus(sum, bpm);
        let click_out = self.scratch[click_index];
        sum[0] += click_out[0];
        sum[1] += click_out[1];
        sum = self.mix.master.limit(sum);
        sum
    }
    /// Drains the delay lines and plug-in inserts with silence after playback ends.
    pub fn drain_frame(&mut self) -> [f32; 2] {
        if !self.compensation_active() {
            return [0.0; 2];
        }
        self.count_in_frame(0.0)
    }
    /// The authored tempo range a fixed tempo is checked against, while a backing track is present.
    pub fn authored_tempos(&self) -> Option<AuthoredTempos> {
        self.has_backing()
            .then(|| AuthoredTempos::of_plan(&self.plan))
    }
    pub fn has_backing(&self) -> bool {
        self.configured_backing || self.backing.is_some()
    }
    /// Puts every kit level at its target for a track that has rendered no frame since the last seek, even if the seek struck held notes again. A stopped or
    /// paused transport renders nothing, so a ramp armed meanwhile would still be on its way when the next note is struck.
    /// A track with notes ringing keeps its ramp, so they resume without a step.
    pub fn settle_idle_kit(&mut self) {
        // The effective kit is the parked mix's if one waits, else the live one, and this is the only place that decides it. A
        // mix parked behind a track DSP crossfade cannot install while nothing renders; it installs later with the same kit and
        // nothing left to ramp.
        let parked = self.parked_mix.as_ref();
        for (index, (track, channel)) in self
            .tracks
            .iter_mut()
            .zip(&mut self.mix.channels)
            .enumerate()
        {
            if track.kit_rendered {
                continue;
            }
            if let Some(next) = parked.and_then(|mix| mix.channels.get(index)) {
                channel.kit.target = next.kit.target;
                channel.kit_active = next.kit_active;
                track.kit_active = next.kit_active;
            }
            channel.kit.current = channel.kit.target;
            channel.kit.remaining = 0;
        }
    }
    /// The transport paused: nothing renders until it plays again, so no board counts as sounding, the parked mix's
    /// included (re-review R2-1). Cheap; called on the audio thread.
    pub fn pause(&mut self) {
        let parked = self.parked_mix.iter_mut().flat_map(|mix| &mut mix.channels);
        for channel in self.mix.channels.iter_mut().chain(parked) {
            channel.dsp.pause();
        }
    }
    /// Whether each channel of the live mix, then of the parked one, is sounding: for tests.
    #[cfg(test)]
    pub(crate) fn channels_sounding(&self) -> Vec<bool> {
        let parked = self.parked_mix.iter().flat_map(|mix| &mix.channels);
        self.mix
            .channels
            .iter()
            .chain(parked)
            .map(|channel| channel.dsp.sounding())
            .collect()
    }
    fn mix_ramping(&self) -> bool {
        self.mix.channels.iter().any(|c| c.dsp.ramping())
            || self.mix.master.ramping()
            || self.mix.compensation.as_ref().is_some_and(|c| c.gliding())
    }
    /// Takes `settings` now, or parks it until the current crossfade ends, when `settle_mix` installs it. A newer mix
    /// replaces a parked one, because only the latest settings still matter. Callback callers retire whatever comes
    /// back on a control thread.
    pub fn replace_mix(&mut self, settings: PreparedMix) -> Option<PreparedMix> {
        if self.parked_mix.is_some() || self.mix_ramping() {
            return self.parked_mix.replace(settings);
        }
        Some(self.install_mix(settings))
    }
    /// Installs a parked mix if the crossfade it waited for has ended. Call between blocks; callback callers retire what
    /// comes back on a control thread, as for `replace_mix`.
    pub fn settle_mix(&mut self) -> Option<PreparedMix> {
        if self.parked_mix.is_none() || self.mix_ramping() {
            return None;
        }
        let settings = self.parked_mix.take()?;
        Some(self.install_mix(settings))
    }
    fn install_mix(&mut self, mut settings: PreparedMix) -> PreparedMix {
        if settings.rate != self.rate || settings.channels.len() != self.mix.channels.len() {
            return settings;
        }
        for (new, old) in settings.channels.iter_mut().zip(&mut self.mix.channels) {
            new.dsp.transition_from(&mut old.dsp);
            new.gain.current = old.gain.current;
            new.gain.remaining = (self.rate as f64 * 0.01) as u32;
            new.kit.current = old.kit.current;
            new.kit.remaining = (self.rate as f64 * 0.01) as u32;
        }
        // A drum map that changed while keys were held: the instrument keeps the keys the plan holds now under the new
        // map and releases the rest, so a key struck under the old map cannot stay on once its NoteOff maps elsewhere.
        // Nothing is struck again. The held keys are put right before the next plan event is dispatched.
        for (index, (new, old)) in settings
            .channels
            .iter_mut()
            .zip(&self.mix.channels)
            .enumerate()
        {
            if new.notes != old.notes {
                if let Some(map) = new.notes.as_ref() {
                    let wanted = Self::held_wanted(
                        &self.plan.midi,
                        &self.midi_track,
                        self.next_midi,
                        index,
                        map,
                    );
                    new.dsp.retain_notes(&wanted);
                }
            }
        }
        settings.backing.current = self.mix.backing.current;
        settings.backing.remaining = (self.rate as f64 * 0.01) as u32;
        settings.master.transition_from(&mut self.mix.master);
        let old_sounding = self.mix.channels.iter().any(|c| c.dsp.sounding());
        carry_compensation(
            &mut settings.compensation,
            &mut self.mix.compensation,
            old_sounding,
        );
        for (track, channel) in self.tracks.iter_mut().zip(&settings.channels) {
            track.kit_active = channel.kit_active;
            track.set_pan_after(channel.pan_after, channel.pan_flat);
        }
        let d_max = settings.compensation.as_ref().map_or(0, |c| c.d_max()) as u64;
        if let Some(tap) = &mut self.midi {
            tap.set_delay_frames(d_max);
        }
        std::mem::replace(&mut self.mix, settings)
    }
    pub fn set_mix(&mut self, settings: PreparedMix) {
        self.parked_mix = None;
        drop(self.install_mix(settings));
    }
    pub fn install_backing(
        &mut self,
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        mix: ChannelMix,
    ) -> Result<(), String> {
        self.install_processed_backing(audio, map, mix, BackingProcessing::default())
    }
    pub fn install_processed_backing(
        &mut self,
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        mix: ChannelMix,
        processing: BackingProcessing,
    ) -> Result<(), String> {
        self.install_processed_backing_shifted(audio, map, mix, processing, 0)
    }
    /// As `install_processed_backing`, with the practice key shift added to the backing's saved pitch.
    pub fn install_processed_backing_shifted(
        &mut self,
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        mix: ChannelMix,
        processing: BackingProcessing,
        extra_semitones: i8,
    ) -> Result<(), String> {
        // The backing follows the score clock in fixed mode as in relative mode, so a fixed tempo that stretches it
        // outside 10% to 300% anywhere in the score is refused here, before anything is installed.
        if let RenderTempo::Fixed { bpm } = self.tempo {
            AuthoredTempos::of_plan(&self.plan).check_fixed(bpm)?;
        }
        validate_mix(&mix)?;
        let mut voice = BackingVoice::new_with_processing_shifted(
            audio,
            map,
            self.rate,
            processing,
            extra_semitones,
        )?;
        voice.seek(self.seconds);
        let any_solo = mix.solo || self.mix.channels.iter().any(|c| c.mix.solo);
        for channel in &mut self.mix.channels {
            channel.gain = Gain::new(
                &channel.mix,
                !channel.mix.mute && (!any_solo || channel.mix.solo),
            );
        }
        self.mix.backing = Gain::new(&mix, !mix.mute && (!any_solo || mix.solo));
        self.backing = Some(voice);
        Ok(())
    }
    pub fn set_metronome(&mut self, enabled: bool) {
        self.set_metronome_settings(MetronomeSettings {
            enabled,
            volume: 0.4,
            visual: false,
            sound: Default::default(),
        });
    }
    pub fn set_metronome_settings(&mut self, settings: MetronomeSettings) {
        let active = self.metronome.enabled || self.metronome.visual;
        self.metronome = settings;
        if active != (settings.enabled || settings.visual) {
            self.reset_click_position();
        }
    }
    fn beat_grid(&self, tick: f64) -> ((usize, usize), f64, bool) {
        let occurrence = self
            .plan
            .occurrences
            .partition_point(|o| o.start_tick <= tick + 1e-7)
            .saturating_sub(1);
        let measure = self.plan.occurrences.get(occurrence);
        let (beat, start) = if let Some(clicks) = measure.and_then(|o| o.click_ticks.as_ref()) {
            let beat = clicks
                .partition_point(|t| *t <= tick + 1e-7)
                .saturating_sub(1);
            (beat, clicks[beat])
        } else {
            let start = measure.map_or(0.0, |o| o.start_tick);
            let pulse_ticks = self.plan.ppq as f64 * 4.0 / self.meter_at(tick).1 as f64;
            let beat = ((tick - start + 1e-7) / pulse_ticks).floor() as usize;
            (beat, start + beat as f64 * pulse_ticks)
        };
        ((occurrence, beat), start, beat == 0)
    }
    fn reset_click_position(&mut self) {
        let tick = self.timeline.seconds_to_tick(self.seconds);
        let (beat, start, _) = self.beat_grid(tick);
        self.last_click = if (tick - start).abs() < 1e-6 {
            None
        } else {
            Some(beat)
        };
        self.click = ClickVoice::new(self.rate);
    }
    pub fn begin_tail(&mut self) {
        self.tail = true;
        if let Some(backing) = &mut self.backing {
            backing.reset_filter();
        }
        let tick = self.timeline.seconds_to_tick(self.seconds);
        for slot in &self.active {
            if let Some(voice) = &mut self.slots[*slot] {
                voice.end_tick = tick;
            }
        }
        // No note starts or ends from here on, so an instrument is told to let go of what it holds.
        for channel in &mut self.mix.channels {
            if channel.notes.is_some() {
                channel.dsp.all_notes_off();
            }
        }
        for track in &mut self.tracks {
            if let Some(synths) = &mut track.drum_synths {
                for synth in synths.iter_mut() {
                    synth.note_off_all(false);
                }
            }
            if let Some(synth) = &mut track.synth {
                synth.note_off_all(false);
            }
        }
        self.click = ClickVoice::new(self.rate);
    }
    pub fn stem_count(&self) -> usize {
        self.plan.tracks.len()
            + usize::from(self.backing.is_some())
            + usize::from(self.metronome.enabled)
    }
    pub fn duration_tick(&self) -> f64 {
        self.plan
            .playback_end_tick
            .unwrap_or_else(|| self.timeline.seconds_to_tick(self.duration_seconds()))
    }
    pub fn score_duration_tick(&self) -> f64 {
        self.plan
            .playback_end_tick
            .unwrap_or(self.plan.duration_tick)
    }
    pub fn duration_seconds(&self) -> f64 {
        if let Some(end) = self.plan.playback_end_tick {
            return self.timeline.tick_to_seconds(end);
        }
        self.backing
            .as_ref()
            .map_or(self.plan.duration_ms / 1000.0, |b| {
                b.end_seconds().max(self.plan.duration_ms / 1000.0)
            })
    }
    pub fn tick_to_seconds(&self, tick: f64) -> f64 {
        self.timeline.tick_to_seconds(tick)
    }
    pub fn position(&self) -> RenderStatus {
        self.status(0, 0, None)
    }
}
pub fn master_limit(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    let absolute = value.abs();
    if absolute <= 0.9 {
        value
    } else {
        value.signum() * (0.9 + 0.1 * ((absolute - 0.9) / 0.1).tanh())
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;
    use std::path::PathBuf;

    fn held_renderer(rate: u32, endpoint: f64, endpoint_events: bool, bent: bool) -> Renderer {
        let note = |id: &str, start: f64, key: u8| {
            serde_json::json!({
                "id":id,"trackId":"guitar","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":if start == 0.0 {0} else {1}},"string":1},
                "occurrence":0,"channel":0,"program":24,"startTick":start,"endTick":2880,
                "key":key,"velocity":127,"articulation":"picked","legatoFrom":null,
            "pitch":if bent && start == 0.0 {
                serde_json::json!([{"tick":0,"semitones":0},{"tick":480,"semitones":12}])
            } else { serde_json::json!([{"tick":start,"semitones":0}]) }
            })
        };
        let mut notes = vec![note("held", 0.0, 69)];
        let mut midi = vec![
            serde_json::json!({"type":"program","trackId":"guitar","tick":0,"channel":0,"program":24}),
            serde_json::json!({"type":"controller","trackId":"guitar","tick":0,"channel":0,"controller":7,"value":64}),
            serde_json::json!({"type":"controller","trackId":"guitar","tick":0,"channel":0,"controller":10,"value":0}),
            serde_json::json!({"type":"controller","trackId":"guitar","tick":0,"channel":0,"controller":64,"value":127}),
            serde_json::json!({"type":"noteOn","trackId":"guitar","tick":0,"channel":0,"key":69,"velocity":127}),
            serde_json::json!({"type":"noteOff","trackId":"guitar","tick":480,"channel":0,"key":69,"velocity":0}),
        ];
        if endpoint_events {
            notes.push(note("endpoint", endpoint, 81));
            midi.extend([
                serde_json::json!({"type":"program","trackId":"guitar","tick":endpoint,"channel":0,"program":0}),
                serde_json::json!({"type":"controller","trackId":"guitar","tick":endpoint,"channel":0,"controller":7,"value":0}),
                serde_json::json!({"type":"controller","trackId":"guitar","tick":endpoint,"channel":0,"controller":10,"value":127}),
                serde_json::json!({"type":"controller","trackId":"guitar","tick":endpoint,"channel":0,"controller":64,"value":0}),
                serde_json::json!({"type":"bend","trackId":"guitar","tick":endpoint,"channel":0,"value":12}),
                serde_json::json!({"type":"noteBend","trackId":"guitar","tick":endpoint,"channel":0,"key":69,"value":12}),
                serde_json::json!({"type":"noteOff","trackId":"guitar","tick":endpoint,"channel":0,"key":69,"velocity":0}),
                serde_json::json!({"type":"noteOn","trackId":"guitar","tick":endpoint,"channel":0,"key":81,"velocity":127}),
            ]);
        }
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
            "generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,
            "tracks":[{"id":"guitar","program":24,"percussion":false}],
            "tempos":[{"tick":0,"bpm":120}],
            "occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
            "notes":notes,"midi":midi
        })).unwrap();
        let mut resources = AudioResources::load_for_requests(
            &PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
            &[],
        )
        .unwrap();
        resources.manifest.instruments = vec![super::super::resources::Instrument {
            id: "green-guitar".into(),
            regions: vec![Region {
                sample_id: "sine".into(),
                root_key: 69,
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
        resources.samples.insert(
            "sine".into(),
            Arc::new(DecodedAudio {
                sample_rate: 48_000,
                channels: 2,
                frames: Arc::new(
                    (0..144_000)
                        .map(|i| {
                            [(std::f64::consts::TAU * 441.0 * i as f64 / 48_000.0).sin() as f32
                                * 0.2; 2]
                        })
                        .collect(),
                ),
            }),
        );
        Renderer::new(
            Arc::new(plan),
            Arc::new(resources),
            DocumentSettings::default(),
            rate,
        )
        .unwrap()
    }

    #[test]
    fn reference_fractional_exit_stops_held_voices_without_tick_roundtrip_leak() {
        for mode in 0..3 {
            let mut renderer = held_renderer(48_000, 960.0, false, false);
            let mut plan = (*renderer.plan).clone();
            plan.playback_end_tick = Some(3840.0);
            plan.tempos[0].bpm = 239.98153988154758;
            plan.duration_tick = 7680.0;
            plan.duration_ms = 2000.153846153846;
            plan.occurrences[0].end_ms = 1000.076923076923;
            plan.notes[0].end_tick = 7680.0;
            renderer.timeline = Timeline::new(&plan).unwrap();
            renderer.note_end_ticks[0] = 7680.0;
            renderer.plan = Arc::new(plan);
            renderer.seek_tick(3839.0);
            let frames = renderer.output_frames_until(3840.0);
            let mut output = [[0.0; 2]; 64];
            match mode {
                0 => {
                    renderer.render_into(&mut output);
                }
                1 => {
                    renderer.render_stems_into(&mut [&mut output]);
                }
                _ => {
                    renderer.render_stems_and_mix_into(&mut [&mut output], &mut [[0.0; 2]; 64]);
                }
            }
            assert!(output[..frames].iter().any(|x| x[0].abs() > 0.001));
            assert!(
                output[frames..].iter().all(|x| *x == [0.0; 2]),
                "mode {mode}: held voice after fractional exit"
            );
            assert_eq!(renderer.duration_tick(), 3840.0);
            assert_eq!(renderer.position().tick, 3840.0);
        }
    }

    #[test]
    fn reference_exit_is_exclusive_for_mix_and_every_stem_path() {
        for rate in [44_100, 48_000] {
            for mode in 0..3 {
                let mut renderer = held_renderer(rate, 960.0, true, false);
                let mut plan = (*renderer.plan).clone();
                plan.playback_end_tick = Some(960.0);
                plan.occurrences[0].end_tick = 960.0;
                plan.occurrences[0].end_ms = 500.0;
                plan.validate().unwrap();
                renderer.plan = Arc::new(plan);
                renderer.set_metronome_settings(MetronomeSettings {
                    enabled: true,
                    visual: true,
                    volume: 0.4,
                    sound: Default::default(),
                });
                renderer.seek_tick(960.0 - 5e-8);
                let mut output = [[1.0; 2]; 8];
                let status = match mode {
                    0 => renderer.render_into(&mut output),
                    1 => renderer.render_stems_into(&mut [&mut output]),
                    _ => renderer.render_stems_and_mix_into(&mut [&mut output], &mut [[0.0; 2]; 8]),
                };
                assert_eq!(renderer.next_note, 1);
                assert_eq!(renderer.next_midi, 6);
                assert_eq!(renderer.tracks[0].channels[0].program, 24);
                assert_eq!(status.pulse_count, 0);
                assert_eq!(status.tick, 960.0);
                assert!(output[1..].iter().all(|x| *x == [0.0; 2]));
                renderer.begin_tail();
                let mut tail = vec![[0.0; 2]; rate as usize / 20];
                renderer.render_into(&mut tail);
                assert!(
                    tail.iter().any(|x| x[0].abs() > 0.001),
                    "score release tail vanished"
                );
                assert_eq!(renderer.next_note, 1);
                assert_eq!(renderer.next_midi, 6);
            }
        }
    }

    #[test]
    fn exclusive_ceiling_blocks_same_tick_events() {
        for rate in [44_100, 48_000] {
            for end in [960.0, 960.0 + 3e-8] {
                let mut renderer = held_renderer(rate, end, true, false);
                renderer.set_metronome_settings(MetronomeSettings {
                    enabled: true,
                    visual: true,
                    volume: 0.4,
                    sound: Default::default(),
                });
                renderer.seek_tick(end - 5e-8);
                let mut output = [[1.0; 2]; 8];
                let status = renderer.render_until(&mut output, end);
                assert_eq!(status.frames, 1);
                assert_eq!(renderer.next_note, 1, "endpoint attack dispatched");
                assert_eq!(renderer.next_midi, 6, "endpoint MIDI dispatched");
                assert_eq!(renderer.tracks[0].channels[0].program, 24);
                assert_eq!(renderer.tracks[0].channels[0].volume, 64.0 / 127.0);
                assert!(renderer.tracks[0].channels[0].sustain);
                if end == 960.0 {
                    assert_eq!(status.pulse_count, 0);
                }
                assert!(output[1..].iter().all(|sample| *sample == [0.0; 2]));
            }
        }
    }

    #[test]
    fn range_seek_reconstructs_state_with_documented_fx_reset() {
        for rate in [44_100, 48_000] {
            let mut renderer = held_renderer(rate, 1920.0, true, true);
            let mut settings = DocumentSettings::default();
            let mut effects = FxSettings::default();
            effects.delay.enabled = true;
            effects.delay.quarter_notes = 0.125;
            settings.sounds.insert(
                "guitar".into(),
                crate::settings::TrackSound {
                    effects,
                    ..Default::default()
                },
            );
            renderer.set_mix(PreparedMix::prepare(&settings, &renderer.plan, rate).unwrap());
            // Let the existing live mix transition settle before comparing two
            // identical seeks with the same accepted effects configuration.
            renderer.render_into(&mut [[0.0; 2]; 2048]);
            renderer
                .set_practice_tempo(RenderTempo::Fixed { bpm: 90.0 })
                .unwrap();
            renderer.seek_tick(960.0);
            let channel = &renderer.tracks[0].channels[0];
            assert_eq!(channel.program, 24);
            assert_eq!(channel.volume, 64.0 / 127.0);
            assert!(channel.sustain);
            assert!(channel.pan[0] > 1.4 && channel.pan[1] == 0.0);
            let mut first = vec![[0.0; 2]; rate as usize / 4];
            renderer.render_until(&mut first, 1920.0);
            assert!(first.iter().any(|x| x[0].abs() > 0.02));
            assert!(first.iter().all(|x| x[1].abs() < 1e-6));
            let crossings = first[rate as usize / 100..]
                .windows(2)
                .filter(|pair| pair[0][0] <= 0.0 && pair[1][0] > 0.0)
                .count();
            assert!(
                (crossings as f64 / 0.24 - 882.0).abs() < 6.0,
                "held 441 Hz source bent up one octave: {crossings}"
            );
            renderer.seek_tick(960.0);
            let mut repeated = vec![[0.0; 2]; first.len()];
            renderer.render_until(&mut repeated, 1920.0);
            assert!(
                first == repeated,
                "seek resets effects and fade deterministically"
            );
            renderer.seek_tick(3000.0);
            renderer.render_until(&mut repeated, 3840.0);
            assert!(
                repeated.iter().all(|sample| *sample == [0.0; 2]),
                "no held voice or historical delay after seeking past its end"
            );
        }
    }

    /// What the plug-in's output is placed by never steps when the track's plug-in comes, goes or changes kind on a track the
    /// score pans hard, and the voices that stand in for it together with that factor are always the score's pan. The step
    /// is looked for from the frame the change is made, where the output still in flight is placed by the leaving kind.
    #[test]
    fn the_pan_that_places_a_plug_in_moves_without_a_step_when_the_plug_in_comes_goes_or_changes_kind()
     {
        const NONE: (bool, bool) = (false, false);
        const EFFECT: (bool, bool) = (true, false);
        const INSTRUMENT: (bool, bool) = (true, true);
        let cases = [
            ("add an instrument", NONE, INSTRUMENT),
            ("add an effect", NONE, EFFECT),
            ("remove an instrument", INSTRUMENT, NONE),
            ("remove an effect", EFFECT, NONE),
            ("effect to instrument", EFFECT, INSTRUMENT),
            ("instrument to effect", INSTRUMENT, EFFECT),
        ];
        for pan in [[0.0, std::f32::consts::SQRT_2], [0.8, 1.2]] {
            for (what, from, to) in cases {
                let mut renderer = held_renderer(48_000, 960.0, false, false);
                let track = &mut renderer.tracks[0];
                track.pan = pan;
                track.pan_late = pan;
                track.pan_seen = pan;
                track.set_pan_after(from.0, from.1);
                track.settle_pan();
                let placed = |track: &Track| track.pan_after_factors();
                let louder = usize::from(pan[1] > pan[0]);
                let mut last = placed(track);
                track.set_pan_after(to.0, to.1);
                let step = 100.0 / 48_000.0;
                for frame in 0..600 {
                    let now = placed(track);
                    for side in 0..2 {
                        // The quieter side's factor moves fast near the unity end of a glide (as an effect's always did), but
                        // what it places there is the quieter side of the score's pan, and the product below is what is held.
                        assert!(
                            side != louder || (now[side] - last[side]).abs() <= 0.004,
                            "{what}, pan {pan:?}: the factor of side {side} steps from {} to {} at frame {frame}",
                            last[side],
                            now[side]
                        );
                        // What the voices keep and what is left to apply after the plug-in make the score's pan.
                        let kept = track.synth_factors();
                        assert!(
                            (kept[side] * now[side] - pan[side]).abs() <= 1e-5
                                || now[side] == 1.0 && kept[side] == pan[side],
                            "{what}, pan {pan:?}: side {side} at frame {frame}"
                        );
                    }
                    last = now;
                    track.glide_pan(step);
                }
            }
        }
    }
}

#[cfg(test)]
mod kit_tests {
    use super::*;
    use crate::settings::DrumElementMix;

    fn plan() -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 1920, "durationMs": 1000,
            "tracks": [{"id": "drums", "program": 0, "percussion": true}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [{"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 1920, "startMs": 0, "endMs": 1000}],
            "notes": [], "midi": []
        }))
        .unwrap()
    }
    fn prepared(kit: Option<DrumKitMix>) -> PreparedMix {
        let mut settings = DocumentSettings::default();
        settings.mixes.insert(
            "drums".into(),
            ChannelMix {
                drum_kit: kit,
                ..Default::default()
            },
        );
        PreparedMix::prepare(&settings, &plan(), 48_000).unwrap()
    }
    fn element(gain: f32, pan: f32, mute: bool, solo: bool) -> Option<DrumElementMix> {
        Some(DrumElementMix {
            gain,
            pan,
            mute,
            solo,
        })
    }

    #[test]
    fn a_kit_of_defaults_is_no_kit() {
        assert!(!prepared(None).channels[0].kit_active);
        let neutral = element(1.0, 0.0, false, false);
        assert!(
            !prepared(Some(DrumKitMix {
                kick: neutral,
                ..Default::default()
            }))
            .channels[0]
                .kit_active
        );
        assert!(
            prepared(Some(DrumKitMix {
                kick: element(0.9, 0.0, false, false),
                ..Default::default()
            }))
            .channels[0]
                .kit_active
        );
    }

    #[test]
    fn element_gains_follow_level_pan_mute_and_solo() {
        let kit = DrumKitMix {
            kick: element(0.5, -0.5, false, false),
            snare: element(1.0, 0.0, true, false),
            hats: element(1.0, 1.0, false, true),
            ..Default::default()
        };
        let gains = KitGain::new(Some(&kit)).current;
        // Hats are the only element soloed: everything else is silent, and a muted snare would be anyway.
        assert_eq!(gains[KitElement::Hats.index()], [0.0, 1.0]);
        assert_eq!(gains[KitElement::Kick.index()], [0.0, 0.0]);
        assert_eq!(gains[KitElement::Snare.index()], [0.0, 0.0]);
        let kit = DrumKitMix {
            kick: element(0.5, -0.5, false, false),
            ..Default::default()
        };
        let gains = KitGain::new(Some(&kit)).current;
        assert_eq!(gains[KitElement::Kick.index()], [0.5, 0.25]);
        assert_eq!(gains[KitElement::Other.index()], [1.0, 1.0]);
        assert_eq!(KitGain::new(None).current, [[1.0; 2]; KIT_ELEMENTS]);
    }

    #[test]
    fn a_level_change_ramps_to_its_target_and_stays() {
        let mut gain = KitGain::new(None);
        gain.target[KitElement::Cymbals.index()] = [0.0, 0.0];
        gain.remaining = 480;
        let first = gain.step()[KitElement::Cymbals.index()][0];
        assert!(first > 0.99 && first < 1.0, "no step on the first frame");
        let mut last = first;
        for _ in 1..480 {
            let next = gain.step()[KitElement::Cymbals.index()][0];
            assert!(next < last, "the level only falls");
            last = next;
        }
        assert_eq!(gain.step()[KitElement::Cymbals.index()], [0.0, 0.0]);
        assert_eq!(gain.step()[KitElement::Kick.index()], [1.0, 1.0]);
    }
}
