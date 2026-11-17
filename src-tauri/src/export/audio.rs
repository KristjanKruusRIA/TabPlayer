use super::{
    stems::{StemKind, StemSpec, StemTimeSegment, StemTrack},
    wav::{AudioFormat, BLOCK_FRAMES},
};
use crate::audio::{
    plan::{PlaybackPlan, Timeline},
    renderer::Renderer,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MeasureRange {
    pub first: u32,
    pub last: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioExportRequest {
    pub tracks: Vec<StemTrack>,
    pub range: Option<MeasureRange>,
    pub format: AudioFormat,
    pub speed: f64,
    pub metronome: bool,
    /// The click the metronome stem and mix use; requests written before it was chosen keep the beep.
    #[serde(default)]
    pub metronome_sound: crate::audio::practice::ClickSound,
    pub tail_seconds: f64,
    pub include_backing: bool,
    pub include_mix: bool,
    /// The RMS level in dB relative to full scale that a mixed export is normalized to; absent for no normalization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalize_rms_db: Option<f64>,
}
/// What the export command receives: the request plus the optional count-in. A count-in is absent from requests
/// written before it existed, which read as none, so they export exactly as they did.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioExportCommand {
    pub tracks: Vec<StemTrack>,
    pub range: Option<MeasureRange>,
    pub format: AudioFormat,
    pub speed: f64,
    pub metronome: bool,
    #[serde(default)]
    pub metronome_sound: crate::audio::practice::ClickSound,
    pub tail_seconds: f64,
    pub include_backing: bool,
    pub include_mix: bool,
    #[serde(default)]
    pub normalize_rms_db: Option<f64>,
    /// Bars of count-in, from the practice settings, to put ahead of a mixed export; absent for none.
    #[serde(default)]
    pub count_in: Option<crate::audio::practice::CountInSettings>,
}
impl AudioExportCommand {
    pub fn into_parts(
        self,
    ) -> (
        AudioExportRequest,
        Option<crate::audio::practice::CountInSettings>,
    ) {
        (
            AudioExportRequest {
                tracks: self.tracks,
                range: self.range,
                format: self.format,
                speed: self.speed,
                metronome: self.metronome,
                metronome_sound: self.metronome_sound,
                tail_seconds: self.tail_seconds,
                include_backing: self.include_backing,
                include_mix: self.include_mix,
                normalize_rms_db: self.normalize_rms_db,
            },
            self.count_in,
        )
    }
}
#[derive(Clone, Debug)]
pub struct Segment {
    pub start_tick: f64,
    pub end_tick: f64,
    pub frames: u64,
}
#[derive(Clone, Debug)]
pub struct RenderSchedule {
    pub segments: Vec<Segment>,
    pub tail_frames: u64,
    pub total_frames: u64,
}
impl RenderSchedule {
    pub fn new(
        plan: &PlaybackPlan,
        range: Option<MeasureRange>,
        rate: u32,
        speed: f64,
        tail_seconds: f64,
        whole_seconds: f64,
    ) -> Result<Self, String> {
        plan.validate()?;
        if ![44100, 48000].contains(&rate)
            || !speed.is_finite()
            || !(0.1..=3.0).contains(&speed)
            || !tail_seconds.is_finite()
            || !(0.0..=30.0).contains(&tail_seconds)
            || !whole_seconds.is_finite()
            || whole_seconds < 0.0
        {
            return Err("Invalid audio export timing settings.".into());
        }
        let timeline = Timeline::new(plan)?;
        let whole_seconds = plan
            .playback_end_tick
            .map_or(whole_seconds, |end| timeline.tick_to_seconds(end));
        let mut segments: Vec<Segment> = Vec::new();
        if let Some(range) = range {
            if range.first > range.last
                || !plan.occurrences.iter().any(|o| o.bar == range.first)
                || !plan.occurrences.iter().any(|o| o.bar == range.last)
            {
                return Err("Choose an inclusive range of existing played measures.".into());
            }
            for o in plan
                .occurrences
                .iter()
                .filter(|o| o.bar >= range.first && o.bar <= range.last)
            {
                let start_tick = plan
                    .notes
                    .iter()
                    .filter(|note| {
                        note.played_bar.unwrap_or(note.source.target.bar) == o.bar
                            && note.occurrence == o.occurrence
                    })
                    .map(|note| note.start_tick)
                    .fold(o.start_tick, f64::min);
                if let Some(last) = segments.last_mut().filter(|s| start_tick <= s.end_tick) {
                    last.end_tick = last.end_tick.max(o.end_tick);
                } else {
                    segments.push(Segment {
                        start_tick,
                        end_tick: o.end_tick,
                        frames: 0,
                    });
                }
            }
            for s in &mut segments {
                s.frames = ((timeline.tick_to_seconds(s.end_tick)
                    - timeline.tick_to_seconds(s.start_tick))
                    * rate as f64
                    / speed)
                    .round() as u64;
            }
        } else {
            segments.push(Segment {
                start_tick: 0.0,
                end_tick: timeline.seconds_to_tick(whole_seconds),
                frames: (whole_seconds * rate as f64 / speed).round() as u64,
            });
        }
        let tail_frames = (tail_seconds * rate as f64).round() as u64;
        let total_frames = segments.iter().map(|s| s.frames).sum::<u64>() + tail_frames;
        Ok(Self {
            segments,
            tail_frames,
            total_frames,
        })
    }
}
/// The caller prepares an immutable Renderer with selected-out tracks muted and backing installed only when requested.
pub struct AudioExportRender {
    renderer: Renderer,
    schedule: RenderSchedule,
    request: AudioExportRequest,
    segment: usize,
    remaining: u64,
    tail_started: bool,
    stem_indices: Vec<usize>,
    stem_buffers: Vec<Vec<[f32; 2]>>,
    mix_buffer: Vec<[f32; 2]>,
    d_max: usize,
    trim_remaining: usize,
    offline: Option<crate::plugins::service::OfflinePlugins>,
    count: Option<crate::audio::practice::CountInClock>,
    /// Count-in frames still to come, and the whole count-in's length.
    count_left: u64,
    count_frames: u64,
    /// Where the count-in's bars are: the start of the first exported bar, with how many frames the export's first
    /// segment begins before it (a note played before the beat, such as a grace note, pulls the segment earlier).
    count_tick: f64,
    count_lead_frames: u64,
    click: crate::audio::practice::ClickVoice,
}
impl AudioExportRender {
    pub fn new(
        renderer: Renderer,
        plan: &PlaybackPlan,
        request: AudioExportRequest,
    ) -> Result<Self, String> {
        Self::new_with_plugins(renderer, plan, request, None)
    }
    pub fn new_with_plugins(
        mut renderer: Renderer,
        plan: &PlaybackPlan,
        request: AudioExportRequest,
        mut offline: Option<crate::plugins::service::OfflinePlugins>,
    ) -> Result<Self, String> {
        if let Some(offline) = &mut offline {
            for (track_id, insert) in offline.inserts.drain(..) {
                if let Some(index) = plan.tracks.iter().position(|t| t.id == track_id) {
                    renderer.attach_plugin(index, insert);
                }
            }
        }
        request.format.validate()?;
        renderer.set_speed(request.speed)?;
        renderer.set_metronome_settings(crate::audio::practice::MetronomeSettings {
            enabled: request.metronome,
            volume: 0.4,
            visual: false,
            sound: request.metronome_sound,
        });
        let schedule = RenderSchedule::new(
            plan,
            request.range,
            request.format.sample_rate,
            request.speed,
            request.tail_seconds,
            renderer.duration_seconds(),
        )?;
        let mut stem_indices = Vec::new();
        let mut ids = std::collections::HashSet::new();
        if request.tracks.is_empty() {
            return Err("Select score tracks to export.".into());
        }
        for track in &request.tracks {
            if !ids.insert(track.id.as_str()) || track.kind != StemKind::Score {
                return Err("Invalid selected export tracks.".into());
            }
            stem_indices.push(
                plan.tracks
                    .iter()
                    .position(|t| t.id == track.id)
                    .ok_or("Export track no longer exists.")?,
            );
        }
        let count = renderer.stem_count();
        let has_backing = count > plan.tracks.len() + usize::from(request.metronome);
        if has_backing && !request.include_backing {
            return Err("Backing must be omitted when preparing this export renderer.".into());
        }
        if has_backing {
            stem_indices.push(plan.tracks.len());
        }
        if request.metronome {
            stem_indices.push(count - 1);
        }
        let remaining = schedule.segments.first().map_or(0, |s| s.frames);
        if let Some(s) = schedule.segments.first() {
            renderer.seek_tick(s.start_tick);
        }
        let d_max = renderer.plugin_delay_frames();
        let rate = request.format.sample_rate;
        // The count-in leads to the first bar's downbeat, which a note played before it does not move.
        let first_start = schedule.segments.first().map_or(0.0, |s| s.start_tick);
        let count_tick = request
            .range
            .and_then(|range| {
                plan.occurrences
                    .iter()
                    .find(|o| o.bar >= range.first && o.bar <= range.last)
            })
            .map_or(first_start, |o| o.start_tick.max(first_start));
        let count_lead_frames = if count_tick > first_start {
            let timeline = Timeline::new(plan)?;
            ((timeline.tick_to_seconds(count_tick) - timeline.tick_to_seconds(first_start))
                * rate as f64
                / request.speed)
                .round() as u64
        } else {
            0
        };
        Ok(Self {
            renderer,
            schedule,
            request,
            segment: 0,
            remaining,
            tail_started: false,
            stem_indices,
            stem_buffers: vec![vec![[0.0; 2]; BLOCK_FRAMES]; count],
            mix_buffer: vec![[0.0; 2]; BLOCK_FRAMES],
            d_max,
            trim_remaining: d_max,
            offline,
            count: None,
            count_left: 0,
            count_frames: 0,
            count_tick,
            count_lead_frames,
            click: crate::audio::practice::ClickVoice::new(rate),
        })
    }
    /// Puts the practice count-in ahead of the music: its bars of clicks at the meter and the export's tempo where the
    /// first exported bar starts, in the chosen click sound. The count-in ends where that bar's downbeat falls, so music
    /// that begins a little earlier, with a grace note, is not pushed off it. The music then follows exactly as it would
    /// without it. Zero bars adds nothing.
    pub fn with_count_in(
        mut self,
        settings: crate::audio::practice::CountInSettings,
    ) -> Result<Self, String> {
        if settings.bars == 0 {
            return Ok(self);
        }
        let start = self.count_tick;
        let (numerator, denominator) = self.renderer.meter_at(start);
        let bpm = self.renderer.authored_bpm_at(start) * self.request.speed;
        let clock = crate::audio::practice::CountInClock::new(
            settings.bars,
            numerator,
            denominator,
            bpm,
            self.request.format.sample_rate,
        )
        .map_err(str::to_string)?;
        let frames = clock
            .snapshot()
            .total_frames
            .saturating_sub(self.count_lead_frames);
        if frames == 0 {
            return Ok(self);
        }
        self.schedule.total_frames += frames;
        self.count_left = frames;
        self.count_frames = frames;
        self.count = Some(clock);
        Ok(self)
    }
    /// The frames the count-in adds ahead of the music: none without one.
    pub fn count_in_frames(&self) -> u64 {
        self.count_frames
    }
    pub fn total_frames(&self) -> u64 {
        self.schedule.total_frames
    }
    pub fn stem_spec(&self) -> StemSpec {
        let mut tracks = self.request.tracks.clone();
        let backing = self.stem_indices.len() > tracks.len() + usize::from(self.request.metronome);
        if backing {
            tracks.push(StemTrack {
                id: "backing".into(),
                name: "Backing".into(),
                preset: "backing".into(),
                kind: StemKind::Backing,
            });
        }
        if self.request.metronome {
            tracks.push(StemTrack {
                id: "metronome".into(),
                name: "Metronome".into(),
                preset: "click".into(),
                kind: StemKind::Metronome,
            });
        }
        if self.request.include_mix {
            tracks.push(StemTrack {
                id: "mix".into(),
                name: "Mix".into(),
                preset: "master-limiter".into(),
                kind: StemKind::Mix,
            });
        }
        StemSpec {
            format: self.request.format,
            tracks,
            start_tick: self.schedule.segments.first().map_or(0.0, |s| s.start_tick),
            end_tick: self.schedule.segments.last().map_or(0.0, |s| s.end_tick),
            speed: self.request.speed,
            metronome: self.request.metronome,
            tail_seconds: self.request.tail_seconds,
            time_segments: {
                let mut offset = 0;
                self.schedule
                    .segments
                    .iter()
                    .map(|s| {
                        let segment = StemTimeSegment {
                            start_tick: s.start_tick,
                            end_tick: s.end_tick,
                            output_start_frame: offset,
                            frames: s.frames,
                        };
                        offset += s.frames;
                        segment
                    })
                    .collect()
            },
        }
    }
    fn next_count(&mut self, capacity: usize) -> usize {
        while self.remaining == 0 {
            if !self.tail_started && self.segment + 1 < self.schedule.segments.len() {
                self.segment += 1;
                let segment = &self.schedule.segments[self.segment];
                // With a plug-in, the join keeps the inserts, the compensation lines and the master streaming. With
                // none, it is the seek it was before plug-ins, so the export stays bit-identical.
                if self.renderer.plugins_active() {
                    self.renderer.wrap_to_tick(segment.start_tick);
                } else {
                    self.renderer.seek_tick(segment.start_tick);
                }
                self.remaining = segment.frames;
            } else if !self.tail_started {
                self.tail_started = true;
                self.renderer.begin_tail();
                self.remaining = self.schedule.tail_frames + self.d_max as u64;
            } else {
                return 0;
            }
        }
        let n = capacity.min(self.remaining as usize).min(BLOCK_FRAMES);
        self.remaining -= n as u64;
        n
    }
    fn check_plugin_faults(&self) -> Result<(), String> {
        if let Some(offline) = &self.offline {
            offline.check_faults()?;
        }
        if self.renderer.plugin_faulted() {
            return Err("Plug-in failed during export.".into());
        }
        Ok(())
    }
    fn trim_pre_roll(&mut self) -> Result<(), String> {
        if self.trim_remaining == 0 {
            return Ok(());
        }
        let mut scratch = [[0.0; 2]; BLOCK_FRAMES];
        while self.trim_remaining > 0 {
            let chunk = self.trim_remaining.min(BLOCK_FRAMES);
            let n = self.next_count(chunk);
            if n == 0 {
                break;
            }
            let status = if self.tail_started {
                self.renderer.render_into(&mut scratch[..n])
            } else {
                self.renderer.render_until(
                    &mut scratch[..n],
                    self.schedule.segments[self.segment].end_tick,
                )
            };
            if status.frames != n {
                return Err(
                    "Native renderer returned an incomplete export block during pre-roll.".into(),
                );
            }
            self.check_plugin_faults()?;
            self.trim_remaining -= n;
        }
        Ok(())
    }
    /// Fills `output` with count-in frames while any remain; the renderer is not advanced, as in playback. With a
    /// plug-in the click goes down the same compensation line as the music, so the count-in and the music are one stream
    /// delayed by `D_max`, and the pre-roll is trimmed from the start of that stream: the first frames the click
    /// produces are dropped, and what the count-in is too short to cover is trimmed from the music.
    fn render_count_in(&mut self, output: &mut [[f32; 2]]) -> usize {
        let Some(clock) = &mut self.count else {
            return 0;
        };
        let cap = output.len().min(BLOCK_FRAMES);
        let mut written = 0;
        while written < cap {
            let frame = clock.next_frame();
            if frame.finished || self.count_left == 0 {
                self.count = None;
                break;
            }
            self.count_left -= 1;
            if let Some(pulse) = frame.pulse {
                self.click
                    .trigger(pulse.accent, self.request.metronome_sound);
            }
            let click = self.click.frame(0.4);
            let out = self.renderer.count_in_frame(click);
            if self.trim_remaining > 0 {
                self.trim_remaining -= 1;
                continue;
            }
            output[written] = out;
            written += 1;
        }
        written
    }
    pub fn render_mix(&mut self, output: &mut [[f32; 2]]) -> Result<usize, String> {
        let counted = self.render_count_in(output);
        if counted > 0 {
            return Ok(counted);
        }
        self.trim_pre_roll()?;
        let n = self.next_count(output.len());
        if n == 0 {
            return Ok(0);
        }
        let status = if self.tail_started {
            self.renderer.render_into(&mut output[..n])
        } else {
            self.renderer.render_until(
                &mut output[..n],
                self.schedule.segments[self.segment].end_tick,
            )
        };
        if status.frames != n {
            return Err("Native renderer returned an incomplete export block.".into());
        }
        self.check_plugin_faults()?;
        Ok(n)
    }
    pub fn render_stems(&mut self, outputs: &mut [Vec<[f32; 2]>]) -> Result<usize, String> {
        if self.count.is_some() {
            return Err("A count-in applies to mixed audio only.".into());
        }
        self.trim_pre_roll()?;
        let expected = self.stem_indices.len() + usize::from(self.request.include_mix);
        if outputs.len() != expected || outputs.iter().any(|b| b.len() < BLOCK_FRAMES) {
            return Err("Stem output buffers do not match the prepared export.".into());
        }
        let n = self.next_count(BLOCK_FRAMES);
        if n == 0 {
            return Ok(0);
        }
        let mut views: Vec<_> = self.stem_buffers.iter_mut().map(|b| &mut b[..n]).collect();
        let ceiling = if self.tail_started {
            f64::INFINITY
        } else {
            self.schedule.segments[self.segment].end_tick
        };
        let status = self.renderer.render_stems_and_mix_until(
            &mut views,
            &mut self.mix_buffer[..n],
            ceiling,
        );
        if status.frames != n {
            return Err("Native renderer returned an incomplete stem block.".into());
        }
        self.check_plugin_faults()?;
        for (output, &index) in outputs.iter_mut().zip(&self.stem_indices) {
            output[..n].copy_from_slice(&self.stem_buffers[index][..n]);
        }
        if self.request.include_mix {
            outputs.last_mut().unwrap()[..n].copy_from_slice(&self.mix_buffer[..n]);
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// Exports run the same renderer the speakers use, but a score that sends tracks to MIDI ports exports every track
    /// and sends nothing: the mix and the stems are bit for bit what they are for the same score without routing.
    #[test]
    fn a_score_routed_to_midi_ports_exports_every_track_exactly_as_it_would_unrouted() {
        use crate::{
            audio::resources::AudioResources,
            settings::{ChannelMix, DocumentSettings, TrackSound},
        };
        use std::sync::Arc;
        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 3840, "durationMs": 2000,
            "tracks": [{"id":"a","program":24,"percussion":false},{"id":"b","program":33,"percussion":false}],
            "tempos": [{"tick":0,"bpm":120}],
            "occurrences": [{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],
            "notes": [],
            "midi": [
                {"type":"noteOn","trackId":"a","tick":0,"channel":0,"key":60,"velocity":100},
                {"type":"noteOn","trackId":"b","tick":480,"channel":0,"key":40,"velocity":100},
                {"type":"noteOff","trackId":"a","tick":1920,"channel":0,"key":60,"velocity":0},
                {"type":"noteOff","trackId":"b","tick":2400,"channel":0,"key":40,"velocity":0}
            ]
        }))
        .unwrap();
        let resources = Arc::new(
            AudioResources::load_for_requests(
                &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &[],
            )
            .unwrap(),
        );
        let settings = |routed: bool| {
            let mut settings = DocumentSettings::default();
            for track in ["a", "b"] {
                settings.sounds.insert(
                    track.into(),
                    TrackSound {
                        voice_id: Some("gm".into()),
                        ..TrackSound::default()
                    },
                );
                if routed {
                    settings.mixes.insert(
                        track.into(),
                        ChannelMix {
                            midi_port: Some("Some port".into()),
                            ..ChannelMix::default()
                        },
                    );
                }
            }
            settings
        };
        let request = AudioExportRequest {
            tracks: ["a", "b"]
                .iter()
                .map(|id| StemTrack {
                    id: (*id).into(),
                    name: (*id).into(),
                    preset: "clean".into(),
                    kind: StemKind::Score,
                })
                .collect(),
            range: None,
            format: AudioFormat::wav(48000, 24),
            speed: 1.0,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds: 0.1,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };
        let render = |routed: bool| {
            let mut export = AudioExportRender::new(
                Renderer::new(
                    Arc::new(plan.clone()),
                    resources.clone(),
                    settings(routed),
                    48000,
                )
                .unwrap(),
                &plan,
                request.clone(),
            )
            .unwrap();
            assert!(
                export.renderer.midi_tap().is_none(),
                "an export has no MIDI routing to send anything with"
            );
            let mut mix = Vec::new();
            let mut buffer = vec![[0.0f32; 2]; 4096];
            loop {
                let n = export.render_mix(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                mix.extend_from_slice(&buffer[..n]);
            }
            let mut stems = AudioExportRender::new(
                Renderer::new(
                    Arc::new(plan.clone()),
                    resources.clone(),
                    settings(routed),
                    48000,
                )
                .unwrap(),
                &plan,
                request.clone(),
            )
            .unwrap();
            let mut stem_samples: Vec<Vec<[f32; 2]>> = vec![Vec::new(); 3];
            let mut outputs = vec![vec![[0.0f32; 2]; BLOCK_FRAMES]; 3];
            loop {
                let n = stems.render_stems(&mut outputs).unwrap();
                if n == 0 {
                    break;
                }
                for (collected, output) in stem_samples.iter_mut().zip(&outputs) {
                    collected.extend_from_slice(&output[..n]);
                }
            }
            (mix, stem_samples)
        };
        let (plain_mix, plain_stems) = render(false);
        let (routed_mix, routed_stems) = render(true);
        let peak =
            |frames: &[[f32; 2]]| frames.iter().flatten().fold(0.0f32, |p, x| p.max(x.abs()));
        assert!(peak(&plain_mix) > 0.01, "the score makes sound");
        assert!(
            peak(&routed_stems[0]) > 0.01 && peak(&routed_stems[1]) > 0.01,
            "every track is in the export"
        );
        let same = |a: &[[f32; 2]], b: &[[f32; 2]]| {
            a.len() == b.len()
                && a.iter().zip(b).all(|(x, y)| {
                    x[0].to_bits() == y[0].to_bits() && x[1].to_bits() == y[1].to_bits()
                })
        };
        assert!(same(&plain_mix, &routed_mix));
        for (plain, routed) in plain_stems.iter().zip(&routed_stems) {
            assert!(same(plain, routed));
        }
    }
    #[test]
    fn exported_native_mix_and_stems_decode_with_aligned_onsets_pitch_and_tail_frames() {
        use crate::audio::{
            decode::DecodedAudio,
            resources::{AudioResources, Instrument, InstrumentManifest, Region},
        };
        use std::{
            collections::HashMap,
            io::Cursor,
            sync::{Arc, atomic::AtomicBool},
        };
        let sample = Arc::new(DecodedAudio {
            sample_rate: 48000,
            channels: 2,
            frames: Arc::new(
                (0..96000)
                    .map(|n| {
                        let x =
                            (std::f64::consts::TAU * 220.0 * n as f64 / 48000.0).sin() as f32 * 0.2;
                        [x, x]
                    })
                    .collect(),
            ),
        });
        let resources = Arc::new(AudioResources {
            manifest: InstrumentManifest {
                schema_version: 1,
                instruments: vec![Instrument {
                    id: "green-guitar".into(),
                    regions: vec![Region {
                        sample_id: "tone".into(),
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
                        release_seconds: 0.1,
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
            samples: HashMap::from([("tone".into(), sample)]),
            sound_font: Arc::new(
                rustysynth::SoundFont::new(&mut Cursor::new(
                    std::fs::read(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/../node_modules/@coderline/alphatab/dist/soundfont/sonivox.sf2"
                    ))
                    .unwrap(),
                ))
                .unwrap(),
            ),
        });
        let plan:Arc<PlaybackPlan>=Arc::new(serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3840,"durationMs":2000,"tracks":[{"id":"a","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000}],"notes":[{"id":"n","trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"startTick":960,"endTick":1920,"key":57,"velocity":100,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":960,"semitones":0}]}],"midi":[]})).unwrap());
        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "a".into(),
                name: "Guitar".into(),
                preset: "clean".into(),
                kind: StemKind::Score,
            }],
            range: None,
            format: AudioFormat::wav(48000, 24),
            speed: 1.0,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds: 0.1,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };
        let make = || {
            AudioExportRender::new(
                Renderer::new(
                    plan.clone(),
                    resources.clone(),
                    crate::settings::DocumentSettings::default(),
                    48000,
                )
                .unwrap(),
                &plan,
                request.clone(),
            )
            .unwrap()
        };
        let d = tempfile::tempdir().unwrap();
        let mut mixed = make();
        assert_eq!(mixed.total_frames(), 100800);
        let path = d.path().join("mix.wav");
        super::super::wav::write_wav(
            &path,
            request.format,
            |b| mixed.render_mix(b),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let mut reader = hound::WavReader::open(path).unwrap();
        assert_eq!(reader.duration(), 100800);
        let samples: Vec<_> = reader
            .samples::<i32>()
            .map(|v| v.unwrap() as f64 / 8388608.0)
            .collect();
        let left: Vec<_> = samples.iter().step_by(2).copied().collect();
        let onset = left.iter().position(|v| v.abs() > 0.001).unwrap();
        assert!((onset as i64 - 24000).abs() < 512);
        let crossings = left[26000..44000]
            .windows(2)
            .filter(|p| p[0] < 0.0 && p[1] >= 0.0)
            .count();
        assert!((crossings as f64 * 48000.0 / 18000.0 - 220.0).abs() < 4.0);
        let mut stemmed = make();
        let spec = stemmed.stem_spec();
        let manifest = super::super::stems::write_stems(
            &d.path().join("stems"),
            &spec,
            |b| stemmed.render_stems(b),
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(manifest.frames, 100800);
        assert_eq!(manifest.tracks.len(), 2);
        for track in &manifest.tracks {
            let r = hound::WavReader::open(d.path().join("stems").join(&track.filename)).unwrap();
            assert_eq!(r.duration(), 100800);
        }
    }
    #[test]
    fn selected_repeated_bars_have_exact_shared_frame_budgets_and_tail() {
        let plan:PlaybackPlan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":11520,"durationMs":6000,"tracks":[{"id":"base/0","program":25,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":0,"endTick":3840,"startMs":0,"endMs":2000},{"bar":1,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":3840,"endTick":7680,"startMs":2000,"endMs":4000},{"bar":0,"occurrence":1,"meterNumerator":4,"meterDenominator":4,"startTick":7680,"endTick":11520,"startMs":4000,"endMs":6000}],"notes":[],"midi":[]})).unwrap();
        let schedule = RenderSchedule::new(
            &plan,
            Some(MeasureRange { first: 0, last: 0 }),
            48000,
            2.0,
            0.5,
            6.0,
        )
        .unwrap();
        assert_eq!(schedule.segments.len(), 2);
        assert_eq!(schedule.segments[0].frames, 48000);
        assert_eq!(schedule.segments[1].start_tick, 7680.0);
        assert_eq!(schedule.total_frames, 120000);
        assert_eq!(schedule.tail_frames, 24000);
        let whole = RenderSchedule::new(&plan, None, 44100, 1.0, 0.0, 8.0).unwrap();
        assert_eq!(whole.total_frames, 352800);
        for speed in [0.1, 1.23, 3.0] {
            let schedule = RenderSchedule::new(&plan, None, 48000, speed, 0.0, 6.0).unwrap();
            assert_eq!(schedule.total_frames, (288000.0 / speed).round() as u64);
        }
        for speed in [0.099, 3.001, f64::NAN, f64::INFINITY] {
            assert!(RenderSchedule::new(&plan, None, 48000, speed, 0.0, 6.0).is_err());
        }
        assert!(
            RenderSchedule::new(
                &plan,
                Some(MeasureRange { first: 1, last: 0 }),
                48000,
                1.0,
                0.0,
                6.0
            )
            .is_err()
        );
    }
    #[test]
    fn selected_first_measure_keeps_its_generated_grace_prelude() {
        let plan:PlaybackPlan=serde_json::from_value(serde_json::json!({"generation":1,"ppq":960,"durationTick":3960,"durationMs":2062.5,"tracks":[{"id":"a","program":24,"percussion":false}],"tempos":[{"tick":0,"bpm":120}],"occurrences":[{"bar":0,"occurrence":0,"meterNumerator":4,"meterDenominator":4,"startTick":120,"endTick":3960,"startMs":62.5,"endMs":2062.5}],"notes":[{"id":"grace","trackId":"a","source":{"target":{"track":0,"staff":0,"bar":0,"voice":0,"beat":0},"string":1},"occurrence":0,"startTick":0,"endTick":120,"key":64,"velocity":90,"articulation":"picked","legatoFrom":null,"pitch":[{"tick":0,"semitones":0}]}],"midi":[]})).unwrap();
        let schedule = RenderSchedule::new(
            &plan,
            Some(MeasureRange { first: 0, last: 0 }),
            48000,
            1.0,
            0.0,
            2.0625,
        )
        .unwrap();
        assert_eq!(schedule.segments[0].start_tick, 0.0);
        assert_eq!(schedule.total_frames, 99000);
    }

    /// A launcher that hosts plug-ins on every system and launches nothing, so the service's own rules run everywhere.
    struct HostsNothingLaunched;

    impl crate::plugins::service::Launcher for HostsNothingLaunched {
        fn launch_session(
            &self,
            _exe: &std::path::Path,
            _bundle: &std::path::Path,
            _class_id: &str,
            _kind: tabplayer_plugin_protocol::control::PluginKind,
            _rate: u32,
            _state: crate::plugins::helper::StateParts,
            _supervisor: &crate::plugins::supervisor::Supervisor,
            _key: crate::plugins::supervisor::HelperKey,
        ) -> Result<
            std::sync::Arc<dyn crate::plugins::service::HelperSession>,
            crate::plugins::helper::HelperError,
        > {
            unreachable!("no helper is launched for a class the library does not hold")
        }

        fn launch_offline(
            &self,
            _exe: &std::path::Path,
            _bundle: &std::path::Path,
            _class_id: &str,
            _kind: tabplayer_plugin_protocol::control::PluginKind,
            _rate: u32,
            _state: crate::plugins::helper::StateParts,
        ) -> Result<
            std::sync::Arc<dyn crate::plugins::service::HelperSession>,
            crate::plugins::helper::HelperError,
        > {
            unreachable!("no helper is launched for a class the library does not hold")
        }

        fn probe(
            &self,
            _exe: &std::path::Path,
            _bundle: &std::path::Path,
            _timeout: std::time::Duration,
        ) -> Result<
            Vec<tabplayer_plugin_protocol::control::ClassInfo>,
            crate::plugins::helper::HelperError,
        > {
            unreachable!()
        }

        fn hosts_plugins(&self) -> bool {
            true
        }
    }

    /// Exports a score whose one track holds a plug-in the library does not know, through `launcher`, and returns the
    /// status the export warns with. The export must fall back to the built-in sound (no inserts) with that one warning.
    fn export_with_unknown_plugin(
        launcher: Option<std::sync::Arc<dyn crate::plugins::service::Launcher>>,
    ) -> crate::plugins::status::PluginStatus {
        use crate::plugins::service::{PluginPaths, PluginService, SlotRequest};
        use crate::settings::{PluginFormat, PluginSlot};
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let paths = PluginPaths {
            helper: dir.path().join("helper.exe"),
            library_dir: dir.path().join("library"),
            consent_file: dir.path().join("consent.json"),
        };
        let service = match launcher {
            Some(launcher) => PluginService::new_with_launcher(paths, Box::new(|_| {}), launcher),
            None => PluginService::new(paths, Box::new(|_| {})).unwrap(),
        };

        let req = SlotRequest {
            percussion: true,
            track_id: "t1".into(),
            slot: PluginSlot {
                kind: crate::settings::SlotKind::Effect,
                active: true,
                format: PluginFormat::Vst3,
                class_id: "missing-class-id".into(),
                name: "Missing Plug".into(),
                vendor: "Test".into(),
                state: "state".into(),
                input_db: 0.0,
                output_db: 0.0,
            },
            state: Arc::new([]),
        };

        let result = service.offline_inserts("doc1", &[req], 48000).unwrap();
        assert!(result.inserts.is_empty());
        assert_eq!(result.warnings.len(), 1);
        result.warnings[0].status
    }

    #[test]
    fn missing_plugin_exports_built_in_with_warning() {
        // A launcher that hosts here (the service's own rule, on every system): the class is not in the library.
        assert_eq!(
            export_with_unknown_plugin(Some(std::sync::Arc::new(HostsNothingLaunched))),
            crate::plugins::status::PluginStatus::Missing
        );
    }

    #[test]
    fn real_launcher_exports_built_in_with_warning_for_a_plugin_it_cannot_host() {
        // The real helper hosts plug-ins on Windows only. Elsewhere the export still falls back to the built-in sound
        // with a warning, but the reason is the platform; on Windows the class is simply not in the library.
        let expected = if cfg!(windows) {
            crate::plugins::status::PluginStatus::Missing
        } else {
            crate::plugins::status::PluginStatus::UnsupportedPlatform
        };
        assert_eq!(export_with_unknown_plugin(None), expected);
    }

    #[test]
    fn needs_consent_exports_built_in_with_warning() {
        use crate::plugins::helper::{HelperError, StateParts};
        use crate::plugins::library::PluginLibrary;
        use crate::plugins::service::{
            HelperSession, Launcher, PluginPaths, PluginService, SlotRequest,
        };
        use crate::plugins::status::PluginStatus;
        use crate::plugins::supervisor::{HelperKey, Supervisor};
        use crate::settings::{PluginFormat, PluginSlot};
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::time::Duration;
        use tabplayer_plugin_protocol::control::ClassInfo;

        let dir = tempfile::tempdir().unwrap();
        let lib_dir = dir.path().join("library");
        std::fs::create_dir_all(&lib_dir).unwrap();
        let fake_bundle = dir.path().join("test.vst3");
        std::fs::write(&fake_bundle, b"module").unwrap();

        let class_id = "A".repeat(32);
        let mut lib = PluginLibrary::open(&lib_dir).unwrap();
        lib.add(&fake_bundle, |_| {
            Ok(vec![ClassInfo {
                class_id: class_id.clone(),
                name: "Test Class".into(),
                vendor: "Vendor".into(),
                version: "1.0".into(),
                subcategories: "Fx".into(),
                kind: tabplayer_plugin_protocol::control::PluginKind::Effect,
            }])
        })
        .unwrap();

        struct CountingLauncher(Arc<AtomicU32>);
        impl Launcher for CountingLauncher {
            fn launch_session(
                &self,
                _exe: &std::path::Path,
                _bundle: &std::path::Path,
                _class_id: &str,
                _kind: tabplayer_plugin_protocol::control::PluginKind,
                _rate: u32,
                _state: StateParts,
                _supervisor: &Supervisor,
                _key: HelperKey,
            ) -> Result<Arc<dyn HelperSession>, HelperError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                panic!("launch_session called unexpectedly");
            }

            fn launch_offline(
                &self,
                _exe: &std::path::Path,
                _bundle: &std::path::Path,
                _class_id: &str,
                _kind: tabplayer_plugin_protocol::control::PluginKind,
                _rate: u32,
                _state: StateParts,
            ) -> Result<Arc<dyn HelperSession>, HelperError> {
                self.0.fetch_add(1, Ordering::SeqCst);
                panic!("launch_offline called unexpectedly");
            }

            fn probe(
                &self,
                _exe: &std::path::Path,
                _bundle: &std::path::Path,
                _timeout: Duration,
            ) -> Result<Vec<ClassInfo>, HelperError> {
                unreachable!()
            }

            // The consent rule is the service's own, so it is tested where the real launcher would say no too.
            fn hosts_plugins(&self) -> bool {
                true
            }
        }

        let launch_count = Arc::new(AtomicU32::new(0));
        let service = PluginService::new_with_launcher(
            PluginPaths {
                helper: dir.path().join("helper.exe"),
                library_dir: lib_dir,
                consent_file: dir.path().join("consent.json"),
            },
            Box::new(|_| {}),
            Arc::new(CountingLauncher(launch_count.clone())),
        );

        let req = SlotRequest {
            percussion: true,
            track_id: "t1".into(),
            slot: PluginSlot {
                kind: crate::settings::SlotKind::Effect,
                active: true,
                format: PluginFormat::Vst3,
                class_id: class_id.clone(),
                name: "Unconsented Plug".into(),
                vendor: "Test".into(),
                state: "unconsented_state".into(),
                input_db: 0.0,
                output_db: 0.0,
            },
            state: Arc::new([]),
        };

        let result = service.offline_inserts("doc1", &[req], 48000).unwrap();
        assert!(result.inserts.is_empty());
        assert_eq!(result.warnings.len(), 1);
        assert_eq!(result.warnings[0].status, PluginStatus::NeedsConsent);
        assert_eq!(
            launch_count.load(Ordering::SeqCst),
            0,
            "no helper is launched when consent is missing"
        );
    }

    #[test]
    fn segments_keep_streaming() {
        use crate::audio::plugin_insert::{InsertMode, PluginInsert};
        use crate::audio::resources::AudioResources;
        use crate::plugins::bridge::{BridgeLink, InsertShared};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        use std::time::Duration;
        use tabplayer_plugin_protocol::ring::{Block, OwnedRing};

        let plan: PlaybackPlan = serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 7680, "durationMs": 4000,
            "tracks": [{"id": "t1", "program": 24, "percussion": false}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000},
                {"bar": 1, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 3840, "endTick": 7680, "startMs": 2000, "endMs": 4000}
            ],
            "notes": [],
            "midi": []
        }))
        .unwrap();

        let resources = Arc::new(
            AudioResources::load_for_requests(
                &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &[],
            )
            .unwrap(),
        );

        let mut settings = crate::settings::DocumentSettings::default();
        settings.sounds.insert(
            "t1".into(),
            crate::settings::TrackSound {
                voice_id: Some("gm".into()),
                ..Default::default()
            },
        );

        let mut renderer =
            Renderer::new(Arc::new(plan.clone()), resources, settings, 48000).unwrap();

        let owned = OwnedRing::new(48000);
        let mut helper = owned.helper();
        let link = BridgeLink::in_process(owned);
        let input_ev = link.input_event().clone();
        let output_ev = link.output_event().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let thread_input_ev = input_ev.clone();
        let helper_thread = std::thread::spawn(move || {
            let mut block: Block = [[0.0; 2]; 128];
            let mut seq = 0;
            while !stop_clone.load(Ordering::Relaxed) {
                thread_input_ev.wait(Duration::from_millis(2));
                while let Some(input) = helper
                    .read_input(
                        seq,
                        &mut block,
                        &mut [0; tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK],
                    )
                    .block()
                {
                    helper.publish_output(seq, input.epoch, &block, &input.meta);
                    output_ev.signal();
                    seq = seq.wrapping_add(1);
                }
            }
        });

        let insert = PluginInsert::new(
            link,
            InsertMode::Offline {
                timeout: Duration::from_secs(5),
            },
            0,
            0.0,
            0.0,
            48000,
            Arc::new(InsertShared::default()),
        )
        .unwrap();

        renderer.attach_plugin(0, Box::new(insert));

        let request = AudioExportRequest {
            tracks: vec![StemTrack {
                id: "t1".into(),
                name: "t1".into(),
                preset: "clean".into(),
                kind: StemKind::Score,
            }],
            range: None,
            format: AudioFormat::wav(48000, 24),
            speed: 1.0,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds: 0.1,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        };

        let mut render =
            AudioExportRender::new_with_plugins(renderer, &plan, request, None).unwrap();
        let mut buffer = vec![[0.0f32; 2]; 4096];
        let mut total = 0;
        loop {
            let n = render.render_mix(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            total += n;
        }
        assert_eq!(total as u64, render.total_frames());
        stop.store(true, Ordering::Relaxed);
        input_ev.signal();
        let _ = helper_thread.join();

        // The length alone holds for a join that flushes too. A range that plays bar 0 twice has two segments; the
        // plug-in track and a dry twin both sound across the join. The join must not drop D_max frames of either,
        // and the plug-in stem must stay frame-aligned with the dry stem on both sides of it.
        assert_two_segments_stream();
    }

    /// A score whose bar 0 plays again after bar 1, with the same note on every track in both of its occurrences.
    fn repeated_bar_plan(tracks: &[&str]) -> PlaybackPlan {
        let mut midi = Vec::new();
        for id in tracks {
            for (on, off) in [(0, 3840), (7680, 11520)] {
                midi.push(serde_json::json!({"type": "noteOn", "trackId": id, "tick": on, "channel": 0, "key": 52, "velocity": 100}));
                midi.push(serde_json::json!({"type": "noteOff", "trackId": id, "tick": off, "channel": 0, "key": 52, "velocity": 0}));
            }
        }
        midi.sort_by_key(|event| event["tick"].as_i64());
        let tracks: Vec<_> = tracks
            .iter()
            .map(|id| serde_json::json!({"id": id, "program": 0, "percussion": false}))
            .collect();
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 11520, "durationMs": 6000,
            "tracks": tracks,
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000},
                {"bar": 1, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 3840, "endTick": 7680, "startMs": 2000, "endMs": 4000},
                {"bar": 0, "occurrence": 1, "meterNumerator": 4, "meterDenominator": 4, "startTick": 7680, "endTick": 11520, "startMs": 4000, "endMs": 6000}
            ],
            "notes": [],
            "midi": midi
        }))
        .unwrap()
    }

    /// General MIDI voices with the built-in Drive, Amp and Cabinet off, which a plug-in would replace.
    fn dry_gm_settings(tracks: &[&str]) -> crate::settings::DocumentSettings {
        let mut settings = crate::settings::DocumentSettings::default();
        for id in tracks {
            let mut sound = crate::settings::TrackSound {
                voice_id: Some("gm".into()),
                ..Default::default()
            };
            sound.effects.drive.enabled = false;
            sound.effects.amp.enabled = false;
            sound.effects.cabinet.enabled = false;
            settings.sounds.insert((*id).into(), sound);
        }
        settings
    }

    fn export_resources() -> std::sync::Arc<crate::audio::resources::AudioResources> {
        std::sync::Arc::new(
            crate::audio::resources::AudioResources::load_for_requests(
                &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/audio"),
                &[],
            )
            .unwrap(),
        )
    }

    fn range_request(tracks: &[&str], tail_seconds: f64) -> AudioExportRequest {
        AudioExportRequest {
            tracks: tracks
                .iter()
                .map(|id| StemTrack {
                    id: (*id).into(),
                    name: (*id).into(),
                    preset: "clean".into(),
                    kind: StemKind::Score,
                })
                .collect(),
            range: Some(MeasureRange { first: 0, last: 0 }),
            format: AudioFormat::wav(48000, 24),
            speed: 1.0,
            metronome: false,
            metronome_sound: Default::default(),
            tail_seconds,
            include_backing: false,
            include_mix: true,
            normalize_rms_db: None,
        }
    }

    fn assert_two_segments_stream() {
        use crate::audio::plugin_insert::{InsertMode, PluginInsert};
        use crate::plugins::bridge::{BridgeLink, InsertShared};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        use std::time::Duration;
        use tabplayer_plugin_protocol::ring::{Block, OwnedRing};

        let ids = ["t1", "t2"];
        let plan = repeated_bar_plan(&ids);
        let mut renderer = Renderer::new(
            Arc::new(plan.clone()),
            export_resources(),
            dry_gm_settings(&ids),
            48000,
        )
        .unwrap();

        // A stand-in helper: each block comes back `LATENCY` frames late, from silence again on every new epoch.
        const LATENCY: usize = 256;
        let owned = OwnedRing::new(48000);
        let mut helper = owned.helper();
        let link = BridgeLink::in_process(owned);
        let input_ev = link.input_event().clone();
        let output_ev = link.output_event().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();
        let thread_input_ev = input_ev.clone();
        let helper_thread = std::thread::spawn(move || {
            let mut block: Block = [[0.0; 2]; 128];
            let mut line = vec![[0.0f32; 2]; LATENCY];
            let mut pos = 0;
            let mut epoch = None;
            let mut seq = 0;
            while !stop_clone.load(Ordering::Relaxed) {
                thread_input_ev.wait(Duration::from_millis(2));
                while let Some(input) = helper
                    .read_input(
                        seq,
                        &mut block,
                        &mut [0; tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK],
                    )
                    .block()
                {
                    if epoch != Some(input.epoch) {
                        line.iter_mut().for_each(|f| *f = [0.0; 2]);
                        epoch = Some(input.epoch);
                    }
                    for frame in block.iter_mut() {
                        let late = line[pos];
                        line[pos] = *frame;
                        pos = (pos + 1) % LATENCY;
                        *frame = late;
                    }
                    helper.publish_output(seq, input.epoch, &block, &input.meta);
                    output_ev.signal();
                    seq = seq.wrapping_add(1);
                }
            }
        });
        let insert = PluginInsert::new(
            link,
            InsertMode::Offline {
                timeout: Duration::from_secs(5),
            },
            LATENCY as u32,
            0.0,
            0.0,
            48000,
            Arc::new(InsertShared::default()),
        )
        .unwrap();
        renderer.attach_plugin(0, Box::new(insert));
        let d_max = renderer.plugin_delay_frames();
        assert!(d_max > LATENCY);

        let mut render =
            AudioExportRender::new_with_plugins(renderer, &plan, range_request(&ids, 0.1), None)
                .unwrap();
        assert_eq!(render.schedule.segments.len(), 2);
        let join = render.schedule.segments[0].frames as usize;
        let mut outputs = vec![vec![[0.0f32; 2]; BLOCK_FRAMES]; 3];
        let mut stems = vec![Vec::new(); 3];
        loop {
            let n = render.render_stems(&mut outputs).unwrap();
            if n == 0 {
                break;
            }
            for (stem, output) in stems.iter_mut().zip(&outputs) {
                stem.extend_from_slice(&output[..n]);
            }
        }
        stop.store(true, Ordering::Relaxed);
        input_ev.signal();
        let _ = helper_thread.join();

        assert_eq!(stems[0].len() as u64, render.total_frames());
        let (plugged, dry) = (&stems[0], &stems[1]);
        assert!(
            dry.iter().any(|f| f[0].abs() > 0.01),
            "the score must sound"
        );
        // With the pre-roll trimmed, output frame `join` is where the second segment's first note starts (the
        // synthesizer's onset is silent for a block). The D_max frames before it are the first segment's held note,
        // which at the join was still in the compensation lines and the insert: a flushing join would silence them.
        for (name, stem) in [("plug-in", plugged), ("dry", dry)] {
            let mut zeros = 0;
            let from = join - d_max - 480;
            for (i, f) in stem[from..join].iter().enumerate() {
                zeros = if f[0] == 0.0 && f[1] == 0.0 {
                    zeros + 1
                } else {
                    0
                };
                assert!(
                    zeros < 32,
                    "the {name} stem falls silent {} frames before the join",
                    join - (from + i)
                );
            }
        }
        for (i, (p, d)) in plugged.iter().zip(dry).enumerate() {
            assert!(
                (p[0] - d[0]).abs() < 1e-6 && (p[1] - d[1]).abs() < 1e-6,
                "frame {i} (join at {join}): the plug-in stem {p:?} is not aligned with the dry stem {d:?}"
            );
        }
    }

    fn render_all_mix(mut render: AudioExportRender) -> (u64, Vec<[f32; 2]>) {
        let mut got = Vec::new();
        let mut buffer = vec![[0.0f32; 2]; 4096];
        loop {
            let n = render.render_mix(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buffer[..n]);
        }
        (render.total_frames(), got)
    }

    fn count_in_export(
        count_in: Option<crate::audio::practice::CountInSettings>,
        sound: crate::audio::practice::ClickSound,
    ) -> (u64, Vec<[f32; 2]>) {
        use std::sync::Arc;
        let ids = ["t1"];
        let plan = repeated_bar_plan(&ids);
        let renderer = Renderer::new(
            Arc::new(plan.clone()),
            export_resources(),
            dry_gm_settings(&ids),
            48000,
        )
        .unwrap();
        let mut request = range_request(&ids, 0.2);
        request.range = None;
        request.metronome_sound = sound;
        let mut render = AudioExportRender::new(renderer, &plan, request).unwrap();
        if let Some(settings) = count_in {
            render = render.with_count_in(settings).unwrap();
        }
        render_all_mix(render)
    }

    /// The count-in is the practice settings' bars of clicks, in the playback click, ahead of the music, which is
    /// exactly what the export is without it.
    #[test]
    fn a_count_in_is_prepended_and_the_music_after_it_is_unchanged() {
        use crate::audio::practice::{ClickSound, ClickVoice, CountInSettings};
        let (base_total, base) = count_in_export(None, ClickSound::Woodblock);
        assert!(
            base.iter().any(|f| f[0].abs() > 0.01),
            "the score must sound"
        );
        assert_eq!(base_total as usize, base.len());
        // 120 bpm in 4/4 is 2 s a bar: two bars at 48 kHz.
        let count_frames = 2 * 96_000usize;
        let (total, with) = count_in_export(
            Some(CountInSettings {
                bars: 2,
                between_loops: false,
            }),
            ClickSound::Woodblock,
        );
        assert_eq!(total as usize, base.len() + count_frames);
        assert_eq!(with.len(), base.len() + count_frames);
        assert_eq!(
            &with[count_frames..],
            &base[..],
            "the music must be sample-identical"
        );
        let mut click = ClickVoice::new(48000);
        let mut expected = vec![[0.0f32; 2]; count_frames];
        for pulse in 0..8usize {
            click.trigger(pulse % 4 == 0, ClickSound::Woodblock);
            let start = pulse * 24_000;
            for frame in &mut expected[start..start + 24_000] {
                let sample = click.frame(0.4);
                *frame = [sample, sample];
            }
        }
        assert_eq!(
            &with[..count_frames],
            &expected[..],
            "the count-in is the playback click"
        );
        assert!(expected.iter().any(|f| f[0].abs() > 0.01));
    }

    /// Requests written before the option, and zero bars, export exactly as before.
    #[test]
    fn no_count_in_leaves_the_export_unchanged_and_an_old_request_still_reads() {
        use crate::audio::practice::{ClickSound, CountInSettings};
        let (_, base) = count_in_export(None, ClickSound::Beep);
        let (_, zero) = count_in_export(
            Some(CountInSettings {
                bars: 0,
                between_loops: false,
            }),
            ClickSound::Beep,
        );
        assert_eq!(base, zero);
        let old = serde_json::json!({
            "tracks": [{"id":"t1","name":"t1","preset":"gm","kind":"score"}],
            "range": null, "format": {"sampleRate":48000,"bitDepth":24}, "speed": 1.0, "metronome": false,
            "tailSeconds": 0.1, "includeBacking": false, "includeMix": true
        });
        let wire: AudioExportCommand = serde_json::from_value(old).unwrap();
        assert!(wire.count_in.is_none());
        let mut new = serde_json::json!({
            "tracks": [{"id":"t1","name":"t1","preset":"gm","kind":"score"}],
            "range": null, "format": {"sampleRate":48000,"bitDepth":24}, "speed": 1.0, "metronome": false,
            "tailSeconds": 0.1, "includeBacking": false, "includeMix": true
        });
        new["countIn"] = serde_json::json!({"bars": 2, "betweenLoops": false});
        let (request, count_in) = serde_json::from_value::<AudioExportCommand>(new)
            .unwrap()
            .into_parts();
        assert_eq!(count_in.unwrap().bars, 2);
        assert!(request.include_mix);
    }

    /// A stand-in plug-in helper: every block comes back `latency` frames late at unity gain, from silence again on each
    /// new epoch. Dropping it stops and joins its thread.
    struct DelayHelper {
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        input: std::sync::Arc<crate::plugins::bridge::EventHandle>,
        thread: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for DelayHelper {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            self.input.signal();
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
    fn delay_insert(
        latency: usize,
    ) -> (Box<crate::audio::plugin_insert::PluginInsert>, DelayHelper) {
        use crate::audio::plugin_insert::{InsertMode, PluginInsert};
        use crate::plugins::bridge::{BridgeLink, InsertShared};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        use std::time::Duration;
        use tabplayer_plugin_protocol::ring::{Block, OwnedRing};
        let owned = OwnedRing::new(48000);
        let mut helper = owned.helper();
        let link = BridgeLink::in_process(owned);
        let input = link.input_event().clone();
        let output = link.output_event().clone();
        let stop = Arc::new(AtomicBool::new(false));
        let (stopped, wake) = (stop.clone(), input.clone());
        let thread = std::thread::spawn(move || {
            let mut block: Block = [[0.0; 2]; 128];
            let mut line = vec![[0.0f32; 2]; latency.max(1)];
            let mut pos = 0;
            let mut epoch = None;
            let mut seq = 0;
            while !stopped.load(Ordering::Relaxed) {
                wake.wait(Duration::from_millis(2));
                while let Some(read) = helper
                    .read_input(
                        seq,
                        &mut block,
                        &mut [0; tabplayer_plugin_protocol::limits::EVENTS_PER_BLOCK],
                    )
                    .block()
                {
                    if epoch != Some(read.epoch) {
                        line.iter_mut().for_each(|f| *f = [0.0; 2]);
                        epoch = Some(read.epoch);
                    }
                    if latency > 0 {
                        for frame in block.iter_mut() {
                            let late = line[pos];
                            line[pos] = *frame;
                            pos = (pos + 1) % latency;
                            *frame = late;
                        }
                    }
                    helper.publish_output(seq, read.epoch, &block, &read.meta);
                    output.signal();
                    seq = seq.wrapping_add(1);
                }
            }
        });
        let insert = PluginInsert::new(
            link,
            InsertMode::Offline {
                timeout: Duration::from_secs(5),
            },
            latency as u32,
            0.0,
            0.0,
            48000,
            Arc::new(InsertShared::default()),
        )
        .unwrap();
        (
            Box::new(insert),
            DelayHelper {
                stop,
                input,
                thread: Some(thread),
            },
        )
    }

    /// The mixed export of `plan`'s track `t1`, with a plug-in of `latency` frames on it, and the count-in ahead of it
    /// where there is one. Returns the output and the compensation delay `D_max`.
    fn plugin_export(
        plan: &PlaybackPlan,
        range: Option<MeasureRange>,
        speed: f64,
        latency: usize,
        count_in: Option<crate::audio::practice::CountInSettings>,
    ) -> (Vec<[f32; 2]>, usize) {
        use std::sync::Arc;
        let ids = ["t1"];
        let mut renderer = Renderer::new(
            Arc::new(plan.clone()),
            export_resources(),
            dry_gm_settings(&ids),
            48000,
        )
        .unwrap();
        let (insert, _helper) = delay_insert(latency);
        renderer.attach_plugin(0, insert);
        let d_max = renderer.plugin_delay_frames();
        let mut request = range_request(&ids, 0.2);
        request.range = range;
        request.speed = speed;
        request.metronome_sound = crate::audio::practice::ClickSound::Woodblock;
        let mut render =
            AudioExportRender::new_with_plugins(renderer, plan, request, None).unwrap();
        if let Some(settings) = count_in {
            render = render.with_count_in(settings).unwrap();
        }
        let total = render.total_frames();
        let (_, out) = render_all_mix(render);
        assert_eq!(
            out.len() as u64,
            total,
            "the frames written are the frames announced"
        );
        (out, d_max)
    }

    /// The playback click for `pulses` pulses `spacing` frames apart, `accent_every` pulses a bar, over `frames` frames.
    fn click_stream(
        frames: usize,
        pulses: usize,
        spacing: usize,
        accent_every: usize,
    ) -> Vec<[f32; 2]> {
        use crate::audio::practice::{ClickSound, ClickVoice};
        let mut click = ClickVoice::new(48000);
        let mut out = vec![[0.0f32; 2]; frames];
        for pulse in 0..pulses {
            click.trigger(pulse % accent_every == 0, ClickSound::Woodblock);
            let start = pulse * spacing;
            for frame in &mut out[start..(start + spacing).min(frames)] {
                let sample = click.frame(0.4);
                *frame = [sample, sample];
            }
        }
        out
    }

    fn first_sound(frames: &[[f32; 2]]) -> Option<usize> {
        frames
            .iter()
            .position(|f| f[0].abs() > 1e-4 || f[1].abs() > 1e-4)
    }

    /// With a plug-in on a track the count-in and the music are one compensated stream: the pre-roll that the plug-in's
    /// delay adds is trimmed once from its start, so the click lands on the beat, the music begins exactly one count-in
    /// after it, and the music is what the export without a count-in holds.
    #[test]
    fn a_count_in_with_a_plugin_stays_on_the_beat_and_the_music_follows_it_exactly() {
        use crate::audio::practice::CountInSettings;
        let plan = repeated_bar_plan(&["t1"]);
        let (base, d_max) = plugin_export(&plan, None, 1.0, 4800, None);
        assert_eq!(d_max, 128 + 4800, "an offline insert's delay");
        let first_note = first_sound(&base).expect("the score must sound");
        let count = 2 * 96_000usize;
        let (with, _) = plugin_export(
            &plan,
            None,
            1.0,
            4800,
            Some(CountInSettings {
                bars: 2,
                between_loops: false,
            }),
        );
        assert_eq!(with.len(), base.len() + count);
        // The click: eight onsets, one a beat (24 000 frames) apart from frame 0.
        let reference = click_stream(count, 8, 24_000, 4);
        for beat in 0..8 {
            let at = beat * 24_000;
            assert_eq!(
                first_sound(&with[at..at + 24_000]),
                first_sound(&reference[at..at + 24_000]),
                "beat {beat}: the click's onset in the beat from frame {at}, with {d_max} frames of delay"
            );
        }
        // The click is whole: the frames the delay moved out of the start are not the click's tail.
        for (i, (got, want)) in with[..count].iter().zip(&reference).enumerate() {
            assert!(
                (got[0] - want[0]).abs() < 1e-4 && (got[1] - want[1]).abs() < 1e-4,
                "count-in frame {i}: {got:?}, the playback click gives {want:?}"
            );
        }
        // The music begins exactly one count-in later and is what the export without a count-in holds.
        assert_eq!(first_sound(&with[count..]), Some(first_note));
        assert_eq!(&with[count..], &base[..], "the music is sample-identical");
    }

    /// A count-in shorter than the plug-in's delay is still one stream: the part of the delay it does not cover is
    /// trimmed from the music's start, so the music begins exactly one count-in in and is what it is without one. (The
    /// renderer drops a click that is still in the compensation line while the metronome is off, which here is the whole
    /// click, so the count-in's frames are silent: playback has the same gap; see the validation note.)
    #[test]
    fn a_count_in_shorter_than_the_plugin_delay_still_lines_up() {
        use crate::audio::practice::CountInSettings;
        let mut plan = repeated_bar_plan(&["t1"]);
        for o in &mut plan.occurrences {
            o.meter_numerator = 1;
            o.meter_denominator = 8;
        }
        // Three times the tempo: an eighth is 4 000 frames, under the 4 928 of delay.
        let (base, d_max) = plugin_export(&plan, None, 3.0, 4800, None);
        let (with, _) = plugin_export(
            &plan,
            None,
            3.0,
            4800,
            Some(CountInSettings {
                bars: 1,
                between_loops: false,
            }),
        );
        let count = 4_000usize;
        assert!(count < d_max);
        assert_eq!(with.len(), base.len() + count);
        assert_eq!(&with[count..], &base[..], "the music is sample-identical");
        assert!(first_sound(&base).is_some(), "the score must sound");
    }

    /// A score whose bar 1 (4/4) follows a bar 0 in 3/4 and opens with a grace note played 30 ticks (750 frames at 120
    /// bpm) before its downbeat, which is what pulls a range export's first segment ahead of the bar.
    fn grace_note_plan() -> PlaybackPlan {
        let note = |id: &str, bar: u32, start: u32, end: u32, key: u8| {
            serde_json::json!({
                "id": id, "trackId": "t1", "occurrence": 0, "startTick": start, "endTick": end, "key": key,
                "velocity": 100, "channel": 0, "articulation": "picked",
                "pitch": [{"tick": start, "semitones": 0.0}],
                "source": {"target": {"track": 0, "staff": 0, "bar": bar, "voice": 0, "beat": 0}, "string": 0}
            })
        };
        let events = |start: u32, end: u32, key: u8| {
            [
                serde_json::json!({"type": "noteOn", "trackId": "t1", "tick": start, "channel": 0, "key": key, "velocity": 100}),
                serde_json::json!({"type": "noteOff", "trackId": "t1", "tick": end, "channel": 0, "key": key, "velocity": 0}),
            ]
        };
        let mut midi = Vec::new();
        midi.extend(events(0, 2880, 52));
        midi.extend(events(2850, 2880, 55));
        midi.extend(events(2880, 6720, 52));
        midi.sort_by_key(|event| event["tick"].as_i64());
        serde_json::from_value(serde_json::json!({
            "generation": 1, "ppq": 960, "durationTick": 6720, "durationMs": 3500,
            "tracks": [{"id": "t1", "program": 0, "percussion": false}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar": 0, "occurrence": 0, "meterNumerator": 3, "meterDenominator": 4, "startTick": 0, "endTick": 2880, "startMs": 0, "endMs": 1500},
                {"bar": 1, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 2880, "endTick": 6720, "startMs": 1500, "endMs": 3500}
            ],
            "notes": [note("a", 0, 0, 2880, 52), note("g", 1, 2850, 2880, 55), note("b", 1, 2880, 6720, 52)],
            "midi": midi
        }))
        .unwrap()
    }

    /// A range export that opens on a bar whose first note is a grace note before the beat takes the count-in's meter and
    /// tempo from the bar, not from the grace note, which falls in the bar before. The count-in leads to the downbeat:
    /// its four beats end where the bar starts, so the music, which opens a grace note early, follows it directly.
    #[test]
    fn a_range_count_in_takes_its_meter_from_the_bar_and_ends_on_the_downbeat() {
        use crate::audio::practice::CountInSettings;
        use std::sync::Arc;
        let plan = grace_note_plan();
        let export = |count_in: Option<CountInSettings>| {
            let renderer = Renderer::new(
                Arc::new(plan.clone()),
                export_resources(),
                dry_gm_settings(&["t1"]),
                48000,
            )
            .unwrap();
            let mut request = range_request(&["t1"], 0.2);
            request.range = Some(MeasureRange { first: 1, last: 1 });
            request.metronome_sound = crate::audio::practice::ClickSound::Woodblock;
            let mut render = AudioExportRender::new(renderer, &plan, request).unwrap();
            assert_eq!(render.schedule.segments[0].start_tick, 2850.0);
            if let Some(settings) = count_in {
                render = render.with_count_in(settings).unwrap();
            }
            render_all_mix(render).1
        };
        let base = export(None);
        let with = export(Some(CountInSettings {
            bars: 1,
            between_loops: false,
        }));
        // Four beats of 24 000 frames, less the 750 frames the music opens ahead of the downbeat.
        let count = 4 * 24_000 - 750;
        assert_eq!(with.len(), base.len() + count);
        assert_eq!(&with[count..], &base[..], "the music is sample-identical");
        assert_eq!(
            &with[..count],
            &click_stream(count, 4, 24_000, 4)[..],
            "four clicks, the first accented"
        );
    }

    /// Normalizing measures the music, not the count-in: the count-in is mostly silence, and counting it would raise the
    /// music above the level the export has without it. The count-in gets the same gain, lowered only so it does not clip.
    #[test]
    fn normalization_measures_the_music_only_and_the_count_in_does_not_change_its_level() {
        use crate::audio::practice::{ClickSound, CountInSettings};
        use crate::export::wav::{NORMALIZE_CEILING_DB, write_normalized_wav_after};
        use std::sync::{Arc, atomic::AtomicBool};
        let plan = repeated_bar_plan(&["t1"]);
        let dir = tempfile::tempdir().unwrap();
        let export = |name: &str, count_in: Option<CountInSettings>| {
            let renderer = Renderer::new(
                Arc::new(plan.clone()),
                export_resources(),
                dry_gm_settings(&["t1"]),
                48000,
            )
            .unwrap();
            let mut request = range_request(&["t1"], 0.2);
            request.range = None;
            request.metronome_sound = ClickSound::Woodblock;
            let mut render = AudioExportRender::new(renderer, &plan, request).unwrap();
            if let Some(settings) = count_in {
                render = render.with_count_in(settings).unwrap();
            }
            let lead = render.count_in_frames();
            let path = dir.path().join(name);
            let result = write_normalized_wav_after(
                &path,
                AudioFormat::wav(48000, 24),
                -16.0,
                lead,
                |output| render.render_mix(output),
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
            let samples: Vec<f64> = hound::WavReader::open(&path)
                .unwrap()
                .samples::<i32>()
                .map(|v| v.unwrap() as f64 / 8_388_608.0)
                .collect();
            (result, samples, lead as usize)
        };
        let (base, base_samples, _) = export("base.wav", None);
        let (with, with_samples, lead) = export(
            "count.wav",
            Some(CountInSettings {
                bars: 2,
                between_loops: false,
            }),
        );
        assert_eq!(lead, 2 * 96_000);
        assert_eq!(with.frames, base.frames + lead as u64);
        assert!(
            base.gain_db < 39.0 && base.gain_db + base.peak_db < NORMALIZE_CEILING_DB - 0.1,
            "the music's gain comes from its level: {base:?}"
        );
        assert!(
            (with.gain_db - base.gain_db).abs() < 1e-9 && (with.rms_db - base.rms_db).abs() < 1e-9,
            "the count-in must not change the gain: {} dB without it, {} dB with it",
            base.gain_db,
            with.gain_db
        );
        // The same samples to within the dither a 24-bit write adds, which follows the frame count.
        assert_eq!(with_samples.len(), base_samples.len() + 2 * lead);
        let worst = with_samples[2 * lead..]
            .iter()
            .zip(&base_samples)
            .fold(0.0f64, |a, (x, y)| a.max((x - y).abs()));
        assert!(
            worst < 3e-7,
            "the music is written at the same level: its samples differ by up to {worst}"
        );
        // The count-in has the music's gain, or less where that would clip.
        let click = click_stream(lead, 8, 24_000, 4);
        let peak = click.iter().fold(0.0f32, |a, f| a.max(f[0].abs())) as f64;
        let gain = 10f64
            .powf(with.gain_db / 20.0)
            .min(10f64.powf(NORMALIZE_CEILING_DB / 20.0) / peak);
        for (i, (got, want)) in with_samples[..2 * lead]
            .iter()
            .zip(click.iter().flatten())
            .enumerate()
        {
            assert!(
                (got - *want as f64 * gain).abs() < 3e-7,
                "count-in sample {i}: {got}, the click at gain {gain} gives {}",
                *want as f64 * gain
            );
        }
        assert!(with_samples[..2 * lead].iter().any(|v| v.abs() > 0.01));
    }

    /// With no plug-in, a range export's segment joins are the seeks they were before plug-ins: a master reverb and
    /// limiter start again at each join, and the bytes do not change.
    #[test]
    fn a_range_export_without_plugins_seeks_at_each_join() {
        use crate::settings::{MasterLimiter, MasterSettings};
        use std::sync::Arc;

        let ids = ["t1"];
        let plan = repeated_bar_plan(&ids);
        let mut settings = dry_gm_settings(&ids);
        let defaults = MasterSettings::default();
        settings.master = Some(MasterSettings {
            reverb: crate::audio::dsp::Reverb {
                enabled: true,
                mix: 0.8,
                room: 0.9,
                damping: 0.1,
                ..defaults.reverb.clone()
            },
            limiter: MasterLimiter {
                enabled: true,
                ceiling_db: -12.0,
                release_ms: 300.0,
            },
            ..defaults
        });
        let request = range_request(&ids, 0.5);

        let renderer = Renderer::new(
            Arc::new(plan.clone()),
            export_resources(),
            settings.clone(),
            48000,
        )
        .unwrap();
        let mut render = AudioExportRender::new(renderer, &plan, request.clone()).unwrap();
        let mut got = Vec::new();
        let mut buffer = vec![[0.0f32; 2]; 4096];
        loop {
            let n = render.render_mix(&mut buffer).unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buffer[..n]);
        }

        let mut reference =
            Renderer::new(Arc::new(plan.clone()), export_resources(), settings, 48000).unwrap();
        reference.set_speed(1.0).unwrap();
        reference.set_metronome_settings(crate::audio::practice::MetronomeSettings {
            enabled: false,
            volume: 0.4,
            visual: false,
            sound: Default::default(),
        });
        let schedule = RenderSchedule::new(
            &plan,
            request.range,
            48000,
            1.0,
            0.5,
            reference.duration_seconds(),
        )
        .unwrap();
        assert_eq!(schedule.segments.len(), 2);
        let mut expected = Vec::new();
        for segment in &schedule.segments {
            reference.seek_tick(segment.start_tick);
            let mut part = vec![[0.0f32; 2]; segment.frames as usize];
            reference.render_until(&mut part, segment.end_tick);
            expected.extend_from_slice(&part);
        }
        reference.begin_tail();
        let mut tail = vec![[0.0f32; 2]; schedule.tail_frames as usize];
        reference.render_into(&mut tail);
        expected.extend_from_slice(&tail);

        assert!(
            expected.iter().any(|f| f[0].abs() > 0.01),
            "the score must sound"
        );
        assert_eq!(got.len(), expected.len());
        for (i, (g, e)) in got.iter().zip(&expected).enumerate() {
            assert_eq!(g, e, "frame {i} differs from seeking at each join");
        }
    }
}
