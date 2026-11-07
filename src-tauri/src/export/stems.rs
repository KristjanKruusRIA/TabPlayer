use super::wav::{AudioContainer, AudioFormat, BLOCK_FRAMES, PcmWriter};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum StemKind {
    Score,
    Backing,
    Metronome,
    Mix,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StemTrack {
    pub id: String,
    pub name: String,
    pub preset: String,
    pub kind: StemKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StemSpec {
    pub format: AudioFormat,
    pub tracks: Vec<StemTrack>,
    pub start_tick: f64,
    pub end_tick: f64,
    pub speed: f64,
    pub metronome: bool,
    pub tail_seconds: f64,
    pub time_segments: Vec<StemTimeSegment>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StemTimeSegment {
    pub start_tick: f64,
    pub end_tick: f64,
    pub output_start_frame: u64,
    pub frames: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestTrack {
    pub id: String,
    pub filename: String,
    pub preset: String,
    pub kind: StemKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StemManifest {
    pub schema_version: u32,
    pub frames: u64,
    pub format: AudioFormat,
    pub start_tick: f64,
    pub end_tick: f64,
    pub speed: f64,
    pub metronome: bool,
    pub tail_seconds: f64,
    pub tracks: Vec<ManifestTrack>,
    #[serde(default)]
    pub time_segments: Vec<StemTimeSegment>,
}
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn filename(index: usize, name: &str, container: AudioContainer) -> String {
    let safe: String = name
        .chars()
        .take(80)
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let safe = safe.trim_matches([' ', '.']);
    format!(
        "{:03}-{}.{}",
        index + 1,
        if safe.is_empty() { "Track" } else { safe },
        container.extension()
    )
}
#[cfg(target_os = "linux")]
fn commit_directory(from: &Path, to: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renameat2(
            oldfd: i32,
            old: *const core::ffi::c_char,
            newfd: i32,
            new: *const core::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let old = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let new = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    if unsafe { renameat2(-100, old.as_ptr(), -100, new.as_ptr(), 1) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}
#[cfg(target_os = "macos")]
fn commit_directory(from: &Path, to: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renamex_np(
            old: *const core::ffi::c_char,
            new: *const core::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let old = CString::new(from.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let new = CString::new(to.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    if unsafe { renamex_np(old.as_ptr(), new.as_ptr(), 4) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().to_string())
    }
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn commit_directory(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::rename(from, to).map_err(|e| e.to_string())
}
pub fn write_stems(
    directory: &Path,
    spec: &StemSpec,
    mut render: impl FnMut(&mut [Vec<[f32; 2]>]) -> Result<usize, String>,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64),
) -> Result<StemManifest, String> {
    spec.format.validate()?;
    if spec.tracks.is_empty()
        || spec.tracks.len() > 129
        || !spec.start_tick.is_finite()
        || !spec.end_tick.is_finite()
        || spec.start_tick < 0.0
        || spec.end_tick < spec.start_tick
        || !spec.speed.is_finite()
        || !(0.25..=2.0).contains(&spec.speed)
        || !spec.tail_seconds.is_finite()
        || !(0.0..=30.0).contains(&spec.tail_seconds)
    {
        return Err("Invalid aligned-stem export settings.".into());
    }
    let parent = std::fs::canonicalize(directory.parent().ok_or("Choose a new stem directory.")?)
        .map_err(|e| e.to_string())?;
    let destination = parent.join(
        directory
            .file_name()
            .ok_or("Choose a new stem directory.")?,
    );
    if destination.exists() {
        return Err(
            "Choose a new directory for this stem set. Existing stems are preserved.".into(),
        );
    }
    if cancel.load(Ordering::Acquire) {
        return Err("Stem export cancelled.".into());
    }
    let stage = Stage(parent.join(format!(
        ".tabplayer-stems-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )));
    std::fs::create_dir(&stage.0).map_err(|e| e.to_string())?;
    let tracks: Vec<_> = spec
        .tracks
        .iter()
        .enumerate()
        .map(|(i, t)| ManifestTrack {
            id: t.id.clone(),
            filename: filename(i, &t.name, spec.format.container),
            preset: t.preset.clone(),
            kind: t.kind.clone(),
        })
        .collect();
    let mut writers = Vec::with_capacity(tracks.len());
    for t in &tracks {
        writers.push(PcmWriter::new(
            File::create(stage.0.join(&t.filename)).map_err(|e| e.to_string())?,
            spec.format,
        )?);
    }
    let mut blocks = vec![vec![[0.0; 2]; BLOCK_FRAMES]; tracks.len()];
    let mut frames = 0;
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err("Stem export cancelled.".into());
        }
        let n = render(&mut blocks)?;
        if n > BLOCK_FRAMES {
            return Err("Renderer returned an invalid stem frame count.".into());
        }
        if n == 0 {
            break;
        }
        for (writer, block) in writers.iter_mut().zip(&blocks) {
            if block[..n]
                .iter()
                .flatten()
                .any(|sample| sample.is_finite() && sample.abs() > 1.0)
            {
                return Err("A stem would clip. Reduce that track's gain and export again.".into());
            }
            writer.write_block(&block[..n])?;
        }
        frames += n as u64;
        progress(frames);
    }
    for writer in writers {
        let (file, count) = writer.finish()?;
        if count != frames {
            return Err("Stem alignment verification failed.".into());
        }
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let manifest = StemManifest {
        schema_version: 1,
        frames,
        format: spec.format,
        start_tick: spec.start_tick,
        end_tick: spec.end_tick,
        speed: spec.speed,
        metronome: spec.metronome,
        tail_seconds: spec.tail_seconds,
        tracks,
        time_segments: spec.time_segments.clone(),
    };
    let mut file = File::create(stage.0.join("manifest.json")).map_err(|e| e.to_string())?;
    file.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if cancel.load(Ordering::Acquire) {
        return Err("Stem export cancelled.".into());
    }
    commit_directory(&stage.0, &destination)?;
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    fn spec() -> StemSpec {
        StemSpec {
            format: AudioFormat::wav(48000, 24),
            tracks: vec![
                StemTrack {
                    id: "base/0".into(),
                    name: "../CON: Ä".into(),
                    preset: "clean".into(),
                    kind: StemKind::Score,
                },
                StemTrack {
                    id: "base/1".into(),
                    name: "../CON: Ä".into(),
                    preset: "gm".into(),
                    kind: StemKind::Score,
                },
            ],
            start_tick: 960.0,
            end_tick: 1920.0,
            speed: 1.0,
            metronome: false,
            tail_seconds: 0.0,
            time_segments: vec![StemTimeSegment {
                start_tick: 960.0,
                end_tick: 1920.0,
                output_start_frame: 0,
                frames: 1200,
            }],
        }
    }
    #[test]
    fn commits_aligned_unique_safe_stems_and_complete_manifest() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("Export Ä");
        let mut remaining = 1200;
        let manifest = write_stems(
            &dest,
            &spec(),
            |outputs| {
                let n = remaining.min(BLOCK_FRAMES);
                outputs[0][..n].fill([0.25, 0.1]);
                outputs[1][..n].fill([0.0, 0.0]);
                remaining -= n;
                Ok(n)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(manifest.frames, 1200);
        assert_ne!(manifest.tracks[0].filename, manifest.tracks[1].filename);
        for track in &manifest.tracks {
            assert!(!track.filename.contains('/'));
            assert!(!track.filename.contains('\\'));
            let mut r = hound::WavReader::open(dest.join(&track.filename)).unwrap();
            assert_eq!(r.duration(), 1200);
            if track.id == "base/1" {
                assert!(r.samples::<i32>().all(|s| s.unwrap().abs() <= 1));
            }
        }
        let stored: StemManifest =
            serde_json::from_slice(&std::fs::read(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(stored.tracks[0].id, "base/0");
        assert_eq!(stored.start_tick, 960.0);
        assert_eq!(stored.time_segments[0].output_start_frame, 0);
        assert_eq!(stored.time_segments[0].frames, 1200);
        assert_eq!(stored.format.bit_depth, 24);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn existing_directory_and_cancel_leave_user_outputs_untouched() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("stems");
        std::fs::create_dir(&dest).unwrap();
        std::fs::write(dest.join("old.wav"), b"old").unwrap();
        assert!(
            write_stems(
                &dest,
                &spec(),
                |_| panic!("must not render"),
                &AtomicBool::new(false),
                |_| {}
            )
            .is_err()
        );
        assert_eq!(std::fs::read(dest.join("old.wav")).unwrap(), b"old");
        let cancel = AtomicBool::new(false);
        let new = root.path().join("new");
        assert!(
            write_stems(
                &new,
                &spec(),
                |_| {
                    cancel.store(true, Ordering::Release);
                    Ok(2)
                },
                &cancel,
                |_| {}
            )
            .is_err()
        );
        assert!(!new.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    }
    #[test]
    fn cannot_silently_clip_pre_limiter_stems() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("stems");
        let mut first = true;
        let result = write_stems(
            &dest,
            &spec(),
            |outputs| {
                if !first {
                    return Ok(0);
                }
                first = false;
                outputs[0][0] = [1.5, 0.0];
                Ok(1)
            },
            &AtomicBool::new(false),
            |_| {},
        );
        assert!(result.unwrap_err().contains("gain"));
        assert!(!dest.exists());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[test]
    fn writes_aiff_stems_named_and_recorded_as_aiff() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("AIFF stems");
        let mut spec = spec();
        spec.format.container = AudioContainer::Aiff;
        let mut remaining = 1200;
        let manifest = write_stems(
            &dest,
            &spec,
            |outputs| {
                let n = remaining.min(BLOCK_FRAMES);
                outputs[0][..n].fill([0.25, 0.1]);
                outputs[1][..n].fill([0.0, 0.0]);
                remaining -= n;
                Ok(n)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert_eq!(manifest.format.container, AudioContainer::Aiff);
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(written["format"]["container"], "aiff");
        for track in &manifest.tracks {
            assert!(track.filename.ends_with(".aiff"), "{}", track.filename);
            let bytes = std::fs::read(dest.join(&track.filename)).unwrap();
            assert_eq!(&bytes[..4], b"FORM");
            assert_eq!(&bytes[8..16], b"AIFFCOMM");
            assert_eq!(bytes.len(), 54 + 1200 * 6);
        }
        // A WAV stem set's manifest does not name a container.
        let wav: serde_json::Value = serde_json::to_value(StemManifest {
            format: AudioFormat::wav(48000, 24),
            ..manifest
        })
        .unwrap();
        assert!(wav["format"].get("container").is_none());
    }
    #[test]
    fn writes_flac_stems_that_decode_to_each_track() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("FLAC stems");
        let mut spec = spec();
        spec.format.container = AudioContainer::Flac;
        let mut remaining = 5000;
        let manifest = write_stems(
            &dest,
            &spec,
            |outputs| {
                let n = remaining.min(BLOCK_FRAMES);
                outputs[0][..n].fill([0.25, 0.1]);
                outputs[1][..n].fill([0.0, 0.0]);
                remaining -= n;
                Ok(n)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let written: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(written["format"]["container"], "flac");
        for (track, level) in manifest.tracks.iter().zip([[0.25, 0.1], [0.0, 0.0]]) {
            assert!(track.filename.ends_with(".flac"), "{}", track.filename);
            let bytes = std::fs::read(dest.join(&track.filename)).unwrap();
            let decoded = crate::audio::decode::decode_audio(&bytes, Some("flac")).unwrap();
            assert_eq!(decoded.frames.len(), 5000);
            // Each stem holds its own track, within the dither.
            for frame in decoded.frames.iter() {
                for (value, expected) in frame.iter().zip(level) {
                    assert!(
                        (value - expected).abs() < 1e-5,
                        "{value} against {expected}"
                    );
                }
            }
        }
    }
    #[test]
    fn writes_ogg_stems_that_decode_to_each_track() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("Ogg stems");
        let mut spec = spec();
        spec.format.container = AudioContainer::Ogg;
        let mut written = 0usize;
        let rate = spec.format.sample_rate as f32;
        let tone = |t: usize| (std::f32::consts::TAU * 440.0 * t as f32 / rate).sin() * 0.4;
        let manifest = write_stems(
            &dest,
            &spec,
            |outputs| {
                let n = (48_000 - written).min(BLOCK_FRAMES);
                for i in 0..n {
                    outputs[0][i] = [tone(written + i); 2];
                }
                outputs[1][..n].fill([0.0, 0.0]);
                written += n;
                Ok(n)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(json["format"]["container"], "ogg");
        let mut energy = vec![];
        for track in &manifest.tracks {
            assert!(track.filename.ends_with(".ogg"), "{}", track.filename);
            let bytes = std::fs::read(dest.join(&track.filename)).unwrap();
            let decoded = crate::audio::decode::decode_audio(&bytes, Some("ogg")).unwrap();
            assert_eq!(decoded.frames.len(), 48_000);
            energy.push(
                decoded
                    .frames
                    .iter()
                    .map(|f| (f[0] * f[0]) as f64)
                    .sum::<f64>()
                    / 48_000.0,
            );
        }
        // The tone is in the first stem only; the silent track decodes to silence.
        assert!(energy[0] > 0.07 && energy[1] < 1e-8, "{energy:?}");
    }
    #[test]
    fn writes_mp3_stems_that_decode_to_each_track() {
        let root = tempfile::tempdir().unwrap();
        let dest = root.path().join("MP3 stems");
        let mut spec = spec();
        spec.format.container = AudioContainer::Mp3;
        let mut written = 0usize;
        let rate = spec.format.sample_rate as f32;
        let tone = |t: usize| (std::f32::consts::TAU * 440.0 * t as f32 / rate).sin() * 0.4;
        let manifest = write_stems(
            &dest,
            &spec,
            |outputs| {
                let n = (48_000 - written).min(BLOCK_FRAMES);
                for i in 0..n {
                    outputs[0][i] = [tone(written + i); 2];
                }
                outputs[1][..n].fill([0.0, 0.0]);
                written += n;
                Ok(n)
            },
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dest.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(json["format"]["container"], "mp3");
        let mut energy = vec![];
        for track in &manifest.tracks {
            assert!(track.filename.ends_with(".mp3"), "{}", track.filename);
            let bytes = std::fs::read(dest.join(&track.filename)).unwrap();
            let decoded = crate::audio::decode::decode_audio(&bytes, Some("mp3")).unwrap();
            assert_eq!(decoded.frames.len(), 48_000);
            energy.push(
                decoded
                    .frames
                    .iter()
                    .map(|f| (f[0] * f[0]) as f64)
                    .sum::<f64>()
                    / 48_000.0,
            );
        }
        // The tone is in the first stem only; the silent track decodes to silence.
        assert!(energy[0] > 0.07 && energy[1] < 1e-8, "{energy:?}");
    }
}
