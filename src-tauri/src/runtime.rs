use crate::{
    assets::StoredAsset,
    audio::{
        backing::BackingMap,
        decode::decode_audio,
        device::{
            AudioDeviceInfo, AudioService, NativeAudioStatus, PracticeSettings, TransportCommand,
        },
        plan::PlaybackPlan,
        renderer::Renderer,
        resources::AudioResources,
        voices::resource_requests,
    },
    export::{
        audio::{AudioExportRender, AudioExportRequest},
        jobs::{ExportJobs, ExportProgress},
        pdf::SvgPage,
    },
    project::{CandidateStore, ProjectSession},
    settings::DocumentSettings,
};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct NativeAudio {
    pub service: AudioService,
    pub root: PathBuf,
    embedded: Mutex<Option<(String, Vec<u8>)>>,
    current_backing: Mutex<Option<String>>,
}
impl NativeAudio {
    pub fn new(root: PathBuf, publish: Arc<dyn Fn(NativeAudioStatus) + Send + Sync>) -> Self {
        Self {
            service: AudioService::new(root.clone(), publish),
            root,
            embedded: Mutex::new(None),
            current_backing: Mutex::new(None),
        }
    }
    fn backing(
        &self,
        settings: &DocumentSettings,
        project: &ProjectSession,
    ) -> Result<Option<Vec<u8>>, String> {
        match &settings.backing {
            None => Ok(None),
            Some(backing) if backing.asset_id == "embedded" => Ok(self
                .embedded
                .lock()
                .unwrap()
                .as_ref()
                .map(|(_, bytes)| bytes.clone())),
            Some(backing) => project.asset_bytes(&backing.asset_id).map(Some),
        }
    }
}

#[tauri::command]
pub async fn audio_prepare(
    plan: PlaybackPlan,
    settings: DocumentSettings,
    embedded_bytes: Option<Vec<u8>>,
    source_key: String,
    practice: Option<PracticeSettings>,
    app: AppHandle,
) -> Result<(), String> {
    settings.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let audio = app.state::<NativeAudio>();
        let mut current_backing = audio.current_backing.lock().unwrap();
        let original = embedded_bytes.or_else(|| {
            audio
                .embedded
                .lock()
                .unwrap()
                .as_ref()
                .filter(|(key, _)| key == &source_key)
                .map(|(_, bytes)| bytes.clone())
        });
        let backing = if settings
            .backing
            .as_ref()
            .is_some_and(|b| b.asset_id == "embedded")
        {
            Some(
                original
                    .clone()
                    .ok_or("Original embedded backing is unavailable; reload the score.")?,
            )
        } else {
            audio.backing(
                &settings,
                &app.state::<Mutex<ProjectSession>>().lock().unwrap(),
            )?
        };
        let backing_id = settings.backing.as_ref().map(|b| b.asset_id.clone());
        let generation = plan.generation;
        let result = audio.service.prepare_with_practice(
            plan,
            settings,
            backing,
            practice.unwrap_or_default(),
        );
        if result.is_ok() || audio.service.prepared_generation() == Some(generation) {
            *audio.embedded.lock().unwrap() = original.map(|bytes| (source_key, bytes));
            *current_backing = backing_id;
        }
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn audio_set_mix(
    settings: DocumentSettings,
    generation: u64,
    app: AppHandle,
) -> Result<(), String> {
    settings.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let audio = app.state::<NativeAudio>();
        let mut current_backing = audio.current_backing.lock().unwrap();
        let backing_id = settings.backing.as_ref().map(|b| b.asset_id.clone());
        if *current_backing == backing_id {
            audio.service.set_mix(settings, generation)?;
        } else {
            let backing = audio.backing(
                &settings,
                &app.state::<Mutex<ProjectSession>>().lock().unwrap(),
            )?;
            audio
                .service
                .set_mix_with_backing(settings, generation, backing)?;
            *current_backing = backing_id;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn audio_command(command: TransportCommand, app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAudio>().service.command(command)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn audio_devices(audio: State<'_, NativeAudio>) -> Result<Vec<AudioDeviceInfo>, String> {
    audio.service.devices()
}
#[tauri::command]
pub fn audio_status(audio: State<'_, NativeAudio>) -> NativeAudioStatus {
    audio.service.status()
}

fn stage_audio(
    bytes: Vec<u8>,
    filename: String,
    candidates: &Mutex<CandidateStore>,
) -> Result<serde_json::Value, String> {
    let decoded = decode_audio(&bytes, None)?;
    let duration_ms = decoded.frames.len() as f64 / decoded.sample_rate as f64 * 1000.0;
    let extension = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("audio")
        .to_ascii_lowercase();
    let media_type = match extension.as_str() {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "ogg" => "audio/ogg",
        _ => "application/octet-stream",
    };
    let asset = StoredAsset::from_bytes(filename, media_type.into(), &bytes);
    let staged = candidates.lock().unwrap().stage_asset(asset)?;
    let mut result = serde_json::to_value(staged).map_err(|e| e.to_string())?;
    result["durationMs"] = serde_json::json!(duration_ms);
    Ok(result)
}
#[tauri::command]
pub async fn stage_backing(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    #[cfg(feature = "desktop-test")]
    let test_path = if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        std::env::var_os("TABPLAYER_TEST_BACKING").map(PathBuf::from)
    } else {
        None
    };
    #[cfg(not(feature = "desktop-test"))]
    let test_path: Option<PathBuf> = None;
    let path = if let Some(path) = test_path {
        path
    } else {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Backing audio", &["wav", "flac", "mp3", "ogg"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        path.into_path().map_err(|e| e.to_string())?
    };
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let filename = std::fs::canonicalize(&path)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .into_owned();
        stage_audio(bytes, filename, &app.state::<Mutex<CandidateStore>>()).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stage_embedded_backing(
    bytes: Vec<u8>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stage_audio(
            bytes,
            "Embedded backing.audio".into(),
            &app.state::<Mutex<CandidateStore>>(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cancel_asset(token: String, candidates: State<'_, Mutex<CandidateStore>>) -> bool {
    candidates.lock().unwrap().cancel_asset(&token)
}

fn export_destination(
    app: &AppHandle,
    extension: &str,
    folder: bool,
) -> Result<Option<PathBuf>, String> {
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        let path = std::env::var_os("TABPLAYER_TEST_EXPORT")
            .map(PathBuf::from)
            .ok_or("Test export destination is missing.")?;
        return Ok(Some(if folder {
            path
        } else {
            path.with_extension(extension)
        }));
    }
    let selected = app
        .dialog()
        .file()
        .set_file_name(if folder {
            "TabPlayer-stems"
        } else {
            "TabPlayer-export"
        })
        .blocking_save_file();
    selected
        .map(|path| {
            path.into_path()
                .map(|path| {
                    if folder {
                        path
                    } else {
                        crate::with_extension(path, extension)
                    }
                })
                .map_err(|e| e.to_string())
        })
        .transpose()
}
#[tauri::command]
pub async fn export_midi(
    bytes: Vec<u8>,
    app: AppHandle,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<bool, String> {
    let Some(path) = export_destination(&app, "mid", false)? else {
        return Ok(false);
    };
    crate::export_to_path(&state.lock().unwrap().snapshot().project, &path, &bytes)?;
    Ok(true)
}
#[tauri::command]
pub async fn export_pdf(
    pages: Vec<SvgPage>,
    print: bool,
    app: AppHandle,
    jobs: State<'_, ExportJobs>,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<Option<String>, String> {
    let destination = if print {
        None
    } else {
        let Some(path) = export_destination(&app, "pdf", false)? else {
            return Ok(None);
        };
        Some(path)
    };
    let project = state.lock().unwrap().snapshot().project;
    if let Some(path) = &destination {
        crate::protect_source(&project, path)?;
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("print");
    let job = jobs.start(pages.len() as u64)?;
    let id = job.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let bytes =
                crate::export::pdf::convert_pages_with_progress(&pages, &job.cancel, |frames| {
                    job.progress(frames)
                })?;
            if job.cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err("PDF export cancelled.".into());
            }
            if let Some(path) = destination {
                crate::export_to_path(&project, &path, &bytes)?;
            } else {
                crate::export::print::prepare_and_open(&bytes, &cache)?;
            }
            Ok(())
        })();
        job.finish(result);
    });
    Ok(Some(id))
}
#[tauri::command]
pub async fn export_audio(
    plan: PlaybackPlan,
    request: AudioExportRequest,
    mut settings: DocumentSettings,
    embedded_bytes: Option<Vec<u8>>,
    stems: bool,
    app: AppHandle,
    jobs: State<'_, ExportJobs>,
    state: State<'_, Mutex<ProjectSession>>,
) -> Result<Option<String>, String> {
    settings.validate()?;
    request.format.validate()?;
    crate::export::audio::RenderSchedule::new(
        &plan,
        request.range,
        request.format.sample_rate,
        request.speed,
        request.tail_seconds,
        plan.duration_ms / 1000.0,
    )?;
    let Some(path) = export_destination(&app, "wav", stems)? else {
        return Ok(None);
    };
    let project = state.lock().unwrap().snapshot().project;
    crate::protect_source(&project, &path)?;
    let audio = app.state::<NativeAudio>();
    let backing = if request.include_backing {
        if settings
            .backing
            .as_ref()
            .is_some_and(|b| b.asset_id == "embedded")
        {
            embedded_bytes
        } else {
            audio.backing(&settings, &state.lock().unwrap())?
        }
    } else {
        settings.backing = None;
        None
    };
    let root = audio.root.clone();
    // Keep plan indices stable; only the selected tracks participate in its mixer.
    for track in &plan.tracks {
        if !request
            .tracks
            .iter()
            .any(|selected| selected.id == track.id)
        {
            let mix = settings.mixes.entry(track.id.clone()).or_default();
            mix.mute = true;
            mix.solo = false;
        }
    }
    let job = jobs.start(0)?;
    let id = job.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let resources = Arc::new(AudioResources::load_for_requests(
                &root,
                &resource_requests(&plan, &settings),
            )?);
            if job.cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err("Audio export cancelled.".into());
            }
            let mut renderer = Renderer::new(
                Arc::new(plan.clone()),
                resources,
                settings.clone(),
                request.format.sample_rate,
            )?;
            if let Some(bytes) = backing {
                let audio = Arc::new(decode_audio(&bytes, None)?);
                let backing = settings
                    .backing
                    .as_ref()
                    .ok_or("Backing settings are missing.")?;
                renderer.install_backing(
                    audio,
                    BackingMap::new(&backing.anchors, backing.offset_ms, &plan)?,
                    backing.mix.clone(),
                )?;
            }
            let format = request.format;
            let mut render = AudioExportRender::new(renderer, &plan, request)?;
            job.total_frames(render.total_frames());
            if stems {
                crate::export::stems::write_stems(
                    &path,
                    &render.stem_spec(),
                    |output| render.render_stems(output),
                    &job.cancel,
                    |frames| job.progress(frames),
                )?;
            } else {
                crate::export::wav::write_wav(
                    &path,
                    format,
                    |output| render.render_mix(output),
                    &job.cancel,
                    |frames| job.progress(frames),
                )?;
            }
            Ok(())
        })();
        job.finish(result);
    });
    Ok(Some(id))
}
#[tauri::command]
pub fn export_status(id: String, jobs: State<'_, ExportJobs>) -> Option<ExportProgress> {
    jobs.status(&id)
}
#[tauri::command]
pub fn cancel_export(id: String, jobs: State<'_, ExportJobs>) -> Result<(), String> {
    jobs.cancel(&id)
}
