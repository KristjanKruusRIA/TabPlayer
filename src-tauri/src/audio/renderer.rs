//! Shared device/offline renderer. Buffers and sample mappings are prepared off the audio thread.
use super::{
    backing::{BackingMap, BackingVoice},
    decode::DecodedAudio,
    dsp::{FxSettings, TrackDsp},
    plan::{Articulation, PlanMidiEvent, PlaybackPlan, Timeline},
    resources::{AudioResources, Region},
    voices::{
        SampleVoice, VoiceParameters, articulation_name, pitch_at, select_region,
        voice_id_for_track,
    },
};
use crate::settings::{ChannelMix, DocumentSettings};
use rustysynth::{Synthesizer, SynthesizerSettings};
use std::{collections::HashMap, sync::Arc};

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
    dsp: TrackDsp,
    gain: Gain,
    mix: ChannelMix,
}
pub struct PreparedMix {
    channels: Vec<PreparedChannel>,
    backing: Gain,
    rate: u32,
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
        settings.validate()?;
        plan.validate()?;
        let minimum_bpm = plan
            .tempos
            .iter()
            .map(|t| t.bpm)
            .fold(f64::INFINITY, f64::min);
        let maximum_delay = 60.0 / minimum_bpm * 4.0 / 0.25;
        let any_solo = plan
            .tracks
            .iter()
            .any(|t| settings.mixes.get(&t.id).is_some_and(|m| m.solo))
            || settings.backing.as_ref().is_some_and(|b| b.mix.solo);
        let mut channels = Vec::with_capacity(plan.tracks.len());
        for track in &plan.tracks {
            let mix = settings.mixes.get(&track.id).cloned().unwrap_or_default();
            validate_mix(&mix)?;
            let fx = settings
                .sounds
                .get(&track.id)
                .map(|s| s.effects.clone())
                .unwrap_or_else(FxSettings::default);
            let dsp = TrackDsp::new(fx, sample_rate, maximum_delay)?;
            channels.push(PreparedChannel {
                dsp,
                gain: Gain::new(&mix, !mix.mute && (!any_solo || mix.solo)),
                mix,
            });
        }
        let backing = settings
            .backing
            .as_ref()
            .map(|b| b.mix.clone())
            .unwrap_or_default();
        validate_mix(&backing)?;
        Ok(Self {
            channels,
            backing: Gain::new(&backing, !backing.mute && (!any_solo || backing.solo)),
            rate: sample_rate,
        })
    }
}
#[derive(Clone, Copy, Debug)]
pub struct RenderStatus {
    pub frames: usize,
    pub tick: f64,
    pub seconds: f64,
    pub ended: bool,
}
#[derive(Clone)]
struct VoiceSample {
    audio: Arc<DecodedAudio>,
    parameters: VoiceParameters,
    release_decay: f64,
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
        };
        Ok(Self {
            audio,
            parameters,
            release_decay: region.release_decay_db_per_second,
        })
    }
    fn instantiate(&self, rate: u32) -> SampleVoice {
        SampleVoice::new(self.audio.clone(), self.parameters, rate)
            .expect("sample validated during preparation")
    }
}
#[derive(Clone)]
struct SelectedNote {
    track: usize,
    attack: VoiceSample,
    release: Option<VoiceSample>,
    noise: Option<VoiceSample>,
    chain: Option<usize>,
    suppress_pick: bool,
}
struct ActiveVoice {
    note: usize,
    track: usize,
    voice: SampleVoice,
    end_tick: f64,
    released: bool,
    release: Option<VoiceSample>,
    started_seconds: f64,
    unpitched: bool,
}
struct Track {
    synth: Option<Synthesizer>,
    ranges: [f64; 16],
    rpn_msb: [u8; 16],
    rpn_lsb: [u8; 16],
}
pub struct Renderer {
    plan: Arc<PlaybackPlan>,
    timeline: Timeline,
    _resources: Arc<AudioResources>,
    rate: u32,
    speed: f64,
    seconds: f64,
    tracks: Vec<Track>,
    selected: Vec<Option<SelectedNote>>,
    slots: Vec<Option<ActiveVoice>>,
    active: Vec<usize>,
    next_note: usize,
    next_midi: usize,
    mix: PreparedMix,
    scratch: Vec<[f32; 2]>,
    backing: Option<BackingVoice>,
    tail: bool,
    metronome: bool,
    last_quarter: i64,
    click_age: usize,
    click_frequency: f64,
}
impl Renderer {
    pub fn new(
        plan: Arc<PlaybackPlan>,
        resources: Arc<AudioResources>,
        settings: DocumentSettings,
        sample_rate: u32,
    ) -> Result<Self, String> {
        let timeline = Timeline::new(&plan)?;
        let mix = PreparedMix::prepare(&settings, &plan, sample_rate)?;
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
        let mut tracks = Vec::with_capacity(plan.tracks.len());
        let mut instruments = Vec::with_capacity(plan.tracks.len());
        for track in &plan.tracks {
            let instrument = voice_id_for_track(track, &settings)
                .map(|id| {
                    resources
                        .manifest
                        .instruments
                        .iter()
                        .position(|i| i.id == id)
                        .ok_or_else(|| format!("Unknown recorded instrument {id}."))
                })
                .transpose()?;
            let synth = if instrument.is_none() {
                let mut config = SynthesizerSettings::new(sample_rate as i32);
                config.maximum_polyphony = 256;
                config.block_size = 8;
                config.enable_reverb_and_chorus = false;
                let mut synth =
                    Synthesizer::new(&resources.sound_font, &config).map_err(|e| e.to_string())?;
                for channel in 0..16 {
                    synth.process_midi_message(channel, 0xc0, track.program as i32, 0);
                }
                Some(synth)
            } else {
                None
            };
            tracks.push(Track {
                synth,
                ranges: [2.0; 16],
                rpn_msb: [127; 16],
                rpn_lsb: [127; 16],
            });
            instruments.push(instrument);
        }
        let mut counters = HashMap::<(usize, u8, u8, &str), usize>::new();
        let mut selected = Vec::with_capacity(plan.notes.len());
        for note in &plan.notes {
            let track = track_indices[note.track_id.as_str()];
            if let Some(index) = instruments[track] {
                let instrument = &resources.manifest.instruments[index];
                let counter = counters
                    .entry((
                        track,
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
                let attack = VoiceSample::new(
                    &resources,
                    region,
                    note.key,
                    note.velocity,
                    note.articulation,
                )?;
                SampleVoice::new(attack.audio.clone(), attack.parameters, sample_rate)?;
                let release = select_region(
                    instrument,
                    note.key,
                    note.velocity,
                    tonal,
                    sequence,
                    "release",
                )
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
                }));
            } else {
                selected.push(None);
            }
        }
        let capacity = plan.notes.len().saturating_mul(3).max(8);
        let slots = (0..capacity).map(|_| None).collect();
        let scratch = vec![[0.0; 2]; plan.tracks.len() + 2];
        Ok(Self {
            plan,
            timeline,
            _resources: resources,
            rate: sample_rate,
            speed: 1.0,
            seconds: 0.0,
            tracks,
            selected,
            slots,
            active: Vec::with_capacity(capacity),
            next_note: 0,
            next_midi: 0,
            mix,
            scratch,
            backing: None,
            tail: false,
            metronome: false,
            last_quarter: -1,
            click_age: usize::MAX,
            click_frequency: 2000.0,
        })
    }
    fn spawn(
        &mut self,
        note: usize,
        track: usize,
        voice: SampleVoice,
        end_tick: f64,
        release: Option<VoiceSample>,
        unpitched: bool,
    ) {
        if let Some(slot) = self.slots.iter().position(Option::is_none) {
            self.slots[slot] = Some(ActiveVoice {
                note,
                track,
                voice,
                end_tick,
                released: false,
                release,
                started_seconds: self.seconds,
                unpitched,
            });
            self.active.push(slot);
        }
    }
    fn start_note(&mut self, index: usize) {
        let Some(selected) = self.selected[index].clone() else {
            return;
        };
        let note = &self.plan.notes[index];
        if let Some(origin) = selected.chain {
            if let Some(slot) = self.active.iter().copied().find(|&i| {
                self.slots[i]
                    .as_ref()
                    .is_some_and(|v| v.note == origin && !v.unpitched && v.voice.is_active())
            }) {
                let active = self.slots[slot].as_mut().unwrap();
                active.voice.transition(note.key, note.articulation);
                active.note = index;
                active.end_tick = note.end_tick;
                active.released = false;
                active.release = selected.release;
                return;
            }
        }
        let end = note.end_tick;
        let mut voice = selected.attack.instantiate(self.rate);
        if selected.suppress_pick {
            voice.seek_elapsed_seconds(0.025, pitch_at(&note.pitch, note.start_tick));
        }
        self.spawn(index, selected.track, voice, end, selected.release, false);
        if let Some(mut noise) = selected.noise {
            noise.parameters.gain_db -= 18.0;
            self.spawn(
                index,
                selected.track,
                noise.instantiate(self.rate),
                end,
                None,
                true,
            );
        }
    }
    fn midi_event(track: &mut Track, event: &PlanMidiEvent) {
        let Some(synth) = &mut track.synth else {
            return;
        };
        match event {
            PlanMidiEvent::NoteOn {
                channel,
                key,
                velocity,
                ..
            } => synth.note_on(*channel as i32, *key as i32, *velocity as i32),
            PlanMidiEvent::NoteOff { channel, key, .. } => {
                synth.note_off(*channel as i32, *key as i32)
            }
            PlanMidiEvent::Program {
                channel, program, ..
            } => synth.process_midi_message(*channel as i32, 0xc0, *program as i32, 0),
            PlanMidiEvent::Controller {
                channel,
                controller,
                value,
                ..
            } => {
                let c = *channel as usize;
                if *controller == 101 {
                    track.rpn_msb[c] = *value;
                }
                if *controller == 100 {
                    track.rpn_lsb[c] = *value;
                }
                if *controller == 6 && track.rpn_msb[c] == 0 && track.rpn_lsb[c] == 0 {
                    track.ranges[c] = (*value as f64).max(1.0);
                }
                synth.process_midi_message(
                    *channel as i32,
                    0xb0,
                    *controller as i32,
                    *value as i32,
                );
            }
            PlanMidiEvent::Bend { channel, value, .. }
            | PlanMidiEvent::NoteBend { channel, value, .. } => {
                let wheel = (8192.0 + *value / track.ranges[*channel as usize] * 8192.0)
                    .round()
                    .clamp(0.0, 16383.0) as i32;
                synth.process_midi_message(*channel as i32, 0xe0, wheel & 127, wheel >> 7);
            }
        }
    }
    fn frame(&mut self) -> [f32; 2] {
        let tick = self.timeline.seconds_to_tick(self.seconds);
        self.scratch.fill([0.0; 2]);
        if !self.tail {
            while self.next_note < self.plan.notes.len()
                && self.plan.notes[self.next_note].start_tick <= tick + 1e-7
            {
                self.start_note(self.next_note);
                self.next_note += 1;
            }
            while self.next_midi < self.plan.midi.len()
                && self.plan.midi[self.next_midi].tick() <= tick + 1e-7
            {
                let event = &self.plan.midi[self.next_midi];
                if let Some(index) = self
                    .plan
                    .tracks
                    .iter()
                    .position(|t| t.id == event.track_id())
                {
                    Self::midi_event(&mut self.tracks[index], event);
                }
                self.next_midi += 1;
            }
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
            let sample = voice.voice.next_frame(pitch);
            for c in 0..2 {
                self.scratch[voice.track][c] += sample[c];
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
                );
            }
        }
        let tempo_index = self
            .plan
            .tempos
            .partition_point(|t| t.tick <= tick)
            .saturating_sub(1);
        let bpm = self.plan.tempos[tempo_index].bpm * self.speed;
        for (index, track) in self.tracks.iter_mut().enumerate() {
            if let Some(synth) = &mut track.synth {
                let mut left = [0.0];
                let mut right = [0.0];
                synth.render(&mut left, &mut right);
                self.scratch[index][0] += left[0];
                self.scratch[index][1] += right[0];
            }
            let channel = &mut self.mix.channels[index];
            self.scratch[index] = channel
                .gain
                .process(channel.dsp.process(self.scratch[index], bpm));
        }
        let backing_index = self.plan.tracks.len();
        if let Some(backing) = &mut self.backing {
            if !self.tail {
                self.scratch[backing_index] =
                    self.mix.backing.process(backing.next_frame(self.seconds));
            }
        }
        if self.metronome {
            let (beat, _, accent) = self.beat_grid(tick);
            if beat != self.last_quarter
                && !self.tail
                && self.seconds < self.plan.duration_ms / 1000.0
            {
                self.last_quarter = beat;
                self.click_age = 0;
                self.click_frequency = if accent { 2400.0 } else { 1800.0 };
            }
            if self.click_age < (self.rate as f64 * 0.05) as usize {
                let age = self.click_age as f64 / self.rate as f64;
                let click = (std::f64::consts::TAU * self.click_frequency * age).sin()
                    * (-age * 100.0).exp()
                    * 0.1;
                self.scratch[backing_index + usize::from(self.backing.is_some())] =
                    [click as f32; 2];
                self.click_age += 1;
            }
        }
        let mut sum = [0.0; 2];
        for sample in self.scratch.iter().take(self.stem_count()) {
            for c in 0..2 {
                sum[c] += sample[c];
            }
        }
        self.seconds += self.speed / self.rate as f64;
        sum.map(master_limit)
    }
    fn status(&self, frames: usize) -> RenderStatus {
        RenderStatus {
            frames,
            tick: self.timeline.seconds_to_tick(self.seconds),
            seconds: self.seconds,
            ended: self.tail || self.seconds + 1e-9 >= self.duration_seconds(),
        }
    }
    pub fn render_into(&mut self, output: &mut [[f32; 2]]) -> RenderStatus {
        for chunk in output.chunks_mut(512) {
            for sample in chunk {
                *sample = self.frame();
            }
        }
        self.status(output.len())
    }
    pub fn render_stems_into(&mut self, outputs: &mut [&mut [[f32; 2]]]) -> RenderStatus {
        let frames = outputs.iter().map(|o| o.len()).min().unwrap_or(0);
        for frame in 0..frames {
            self.frame();
            for (channel, output) in outputs.iter_mut().enumerate() {
                output[frame] = self.scratch.get(channel).copied().unwrap_or([0.0; 2]);
            }
        }
        self.status(frames)
    }
    pub fn render_stems_and_mix_into(
        &mut self,
        outputs: &mut [&mut [[f32; 2]]],
        mix: &mut [[f32; 2]],
    ) -> RenderStatus {
        let frames = outputs
            .iter()
            .map(|o| o.len())
            .min()
            .unwrap_or(mix.len())
            .min(mix.len());
        for frame in 0..frames {
            mix[frame] = self.frame();
            for (channel, output) in outputs.iter_mut().enumerate() {
                output[frame] = self.scratch.get(channel).copied().unwrap_or([0.0; 2]);
            }
        }
        self.status(frames)
    }
    pub fn seek_tick(&mut self, tick: f64) {
        let tick = if tick.is_finite() {
            tick.clamp(0.0, self.duration_tick())
        } else {
            0.0
        };
        self.seconds = self.timeline.tick_to_seconds(tick);
        self.tail = false;
        for slot in &mut self.slots {
            *slot = None;
        }
        self.active.clear();
        for channel in &mut self.mix.channels {
            channel.dsp.reset();
        }
        self.next_note = self.plan.notes.partition_point(|n| n.start_tick < tick);
        self.next_midi = self.plan.midi.partition_point(|m| m.tick() < tick);
        for index in 0..self.next_note {
            if self.plan.notes[index].end_tick > tick {
                self.start_note(index);
                if let Some(slot) = self.active.iter().copied().find(|&i| {
                    self.slots[i]
                        .as_ref()
                        .is_some_and(|v| v.note == index && !v.unpitched)
                }) {
                    let elapsed = (self.seconds
                        - self
                            .timeline
                            .tick_to_seconds(self.plan.notes[index].start_tick))
                        / self.speed;
                    let pitch = pitch_at(&self.plan.notes[index].pitch, tick);
                    self.slots[slot]
                        .as_mut()
                        .unwrap()
                        .voice
                        .seek_elapsed_seconds(elapsed, pitch);
                }
            }
        }
        for (track_index, track) in self.tracks.iter_mut().enumerate() {
            if let Some(synth) = &mut track.synth {
                synth.reset();
                for channel in 0..16 {
                    synth.process_midi_message(
                        channel,
                        0xc0,
                        self.plan.tracks[track_index].program as i32,
                        0,
                    );
                }
            }
            track.ranges = [2.0; 16];
            track.rpn_msb = [127; 16];
            track.rpn_lsb = [127; 16];
            let mut held = [[0u8; 128]; 16];
            let mut velocities = [[0u8; 128]; 16];
            for event in self
                .plan
                .midi
                .iter()
                .take(self.next_midi)
                .filter(|e| e.track_id() == self.plan.tracks[track_index].id)
            {
                match event {
                    PlanMidiEvent::NoteOn {
                        channel,
                        key,
                        velocity,
                        ..
                    } => {
                        held[*channel as usize][*key as usize] =
                            held[*channel as usize][*key as usize].saturating_add(1);
                        velocities[*channel as usize][*key as usize] = *velocity;
                    }
                    PlanMidiEvent::NoteOff { channel, key, .. } => {
                        held[*channel as usize][*key as usize] =
                            held[*channel as usize][*key as usize].saturating_sub(1);
                    }
                    _ => Self::midi_event(track, event),
                }
            }
            if let Some(synth) = &mut track.synth {
                for c in 0..16 {
                    for key in 0..128 {
                        if held[c][key] > 0 {
                            synth.note_on(c as i32, key as i32, velocities[c][key] as i32);
                        }
                    }
                }
            }
        }
        if let Some(backing) = &mut self.backing {
            backing.seek(self.seconds);
        }
        self.reset_click_position();
    }
    pub fn set_speed(&mut self, speed: f64) -> Result<(), String> {
        if !speed.is_finite() || !(0.25..=2.0).contains(&speed) {
            return Err("Practice speed must be 25–200%.".into());
        }
        self.speed = speed;
        Ok(())
    }
    /// Callback callers retire the returned old configuration on a control thread.
    pub fn replace_mix(&mut self, mut settings: PreparedMix) -> PreparedMix {
        if settings.rate != self.rate || settings.channels.len() != self.mix.channels.len() {
            return settings;
        }
        for (new, old) in settings.channels.iter_mut().zip(&mut self.mix.channels) {
            new.dsp.transition_from(&mut old.dsp);
            new.gain.current = old.gain.current;
            new.gain.remaining = (self.rate as f64 * 0.01) as u32;
        }
        settings.backing.current = self.mix.backing.current;
        settings.backing.remaining = (self.rate as f64 * 0.01) as u32;
        std::mem::replace(&mut self.mix, settings)
    }
    pub fn set_mix(&mut self, settings: PreparedMix) {
        drop(self.replace_mix(settings));
    }
    pub fn install_backing(
        &mut self,
        audio: Arc<DecodedAudio>,
        map: BackingMap,
        mix: ChannelMix,
    ) -> Result<(), String> {
        validate_mix(&mix)?;
        let mut voice = BackingVoice::new(audio, map, self.rate)?;
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
        self.metronome = enabled;
        self.reset_click_position();
    }
    fn beat_grid(&self, tick: f64) -> (i64, f64, bool) {
        let occurrence = self
            .plan
            .occurrences
            .partition_point(|o| o.start_tick <= tick + 1e-7)
            .saturating_sub(1);
        let start = self
            .plan
            .occurrences
            .get(occurrence)
            .map_or(0.0, |o| o.start_tick);
        let beat = ((tick - start + 1e-7) / self.plan.ppq as f64).floor() as i64;
        (
            occurrence as i64 * 1_000_000 + beat,
            start + beat as f64 * self.plan.ppq as f64,
            beat == 0,
        )
    }
    fn reset_click_position(&mut self) {
        let tick = self.timeline.seconds_to_tick(self.seconds);
        let (beat, start, _) = self.beat_grid(tick);
        self.last_quarter = if (tick - start).abs() < 1e-6 {
            -1
        } else {
            beat
        };
        self.click_age = usize::MAX;
    }
    pub fn begin_tail(&mut self) {
        self.tail = true;
        let tick = self.timeline.seconds_to_tick(self.seconds);
        for slot in &self.active {
            if let Some(voice) = &mut self.slots[*slot] {
                voice.end_tick = tick;
            }
        }
        for track in &mut self.tracks {
            if let Some(synth) = &mut track.synth {
                synth.note_off_all(false);
            }
        }
        self.click_age = usize::MAX;
    }
    pub fn stem_count(&self) -> usize {
        self.plan.tracks.len() + usize::from(self.backing.is_some()) + usize::from(self.metronome)
    }
    pub fn duration_tick(&self) -> f64 {
        self.timeline.seconds_to_tick(self.duration_seconds())
    }
    pub fn duration_seconds(&self) -> f64 {
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
        self.status(0)
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
