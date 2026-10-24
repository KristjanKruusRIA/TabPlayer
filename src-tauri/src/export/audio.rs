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
    pub tail_seconds: f64,
    pub include_backing: bool,
    pub include_mix: bool,
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
}
impl AudioExportRender {
    pub fn new(
        mut renderer: Renderer,
        plan: &PlaybackPlan,
        request: AudioExportRequest,
    ) -> Result<Self, String> {
        request.format.validate()?;
        renderer.set_speed(request.speed)?;
        renderer.set_metronome(request.metronome);
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
        })
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
                self.renderer.seek_tick(segment.start_tick);
                self.remaining = segment.frames;
            } else if !self.tail_started {
                self.tail_started = true;
                self.renderer.begin_tail();
                self.remaining = self.schedule.tail_frames;
            } else {
                return 0;
            }
        }
        let n = capacity.min(self.remaining as usize).min(BLOCK_FRAMES);
        self.remaining -= n as u64;
        n
    }
    pub fn render_mix(&mut self, output: &mut [[f32; 2]]) -> Result<usize, String> {
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
        Ok(n)
    }
    pub fn render_stems(&mut self, outputs: &mut [Vec<[f32; 2]>]) -> Result<usize, String> {
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
            tail_seconds: 0.1,
            include_backing: false,
            include_mix: true,
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
}
