use crate::{
    assets::StoredAsset,
    audio::{
        audition::{AuditionClip, AuditionRequest, AuditionResult, render_clip},
        backing::BackingMap,
        decode::{DecodedAudio, decode_audio},
        device::{
            AudioDeviceInfo, AudioService, NativeAudioStatus, PracticeSettings, TransportCommand,
        },
        plan::PlaybackPlan,
        reference_sync::ReferenceSyncMap,
        renderer::Renderer,
        resources::AudioResources,
        voices::resource_requests,
    },
    export::{
        audio::{AudioExportRender, AudioExportRequest},
        jobs::{ExportJobs, ExportProgress, JobHandle},
        pdf::SvgPage,
    },
    file_library::protected::ProtectedPaths,
    project::ProjectView,
    settings::DocumentSettings,
    workspace::{AudioOwner, DocumentRevision, DocumentWorkspace},
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, TryLockError,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[cfg(test)]
#[path = "document_audio_ownership_tests.rs"]
mod document_audio_ownership_tests;

#[cfg(test)]
#[path = "file_library/protected_runtime_tests.rs"]
mod protected_runtime_tests;

#[cfg(test)]
#[path = "reference_export_tests.rs"]
mod reference_export_tests;

#[cfg(test)]
#[path = "backing_processing_runtime_tests.rs"]
mod backing_processing_runtime_tests;

struct ExportCapture {
    job: JobHandle,
    backing: Option<Vec<u8>>,
    projects: Vec<ProjectView>,
    protected_paths: ProtectedPaths,
}

impl ExportCapture {
    fn protect_destination(&self, path: &Path) -> Result<(), String> {
        self.protected_paths.check(path)?;
        for project in &self.projects {
            crate::protect_source(project, path)?;
        }
        Ok(())
    }

    fn protect_stem_destination(&self, path: &Path) -> Result<(), String> {
        self.protected_paths
            .check(path.parent().ok_or("Choose a new stem directory.")?)?;
        self.protect_destination(path)
    }

    fn print_cache(&self, cache: &Path) -> Result<PathBuf, String> {
        self.protected_paths.check(cache)?;
        std::fs::create_dir_all(cache).map_err(|error| error.to_string())?;
        let cache = std::fs::canonicalize(cache).map_err(|error| error.to_string())?;
        self.protected_paths.check(&cache)?;
        Ok(cache)
    }
}

pub struct NativeAudio {
    pub service: AudioService,
    pub root: PathBuf,
    pub(crate) access: Mutex<()>,
    audition_sequence: AtomicU64,
    audition_render: Mutex<()>,
    embedded: Mutex<Option<(String, Vec<u8>)>>,
    current_backing: Mutex<Option<String>>,
    protected_paths: ProtectedPaths,
}
impl NativeAudio {
    pub fn new(root: PathBuf, publish: Arc<dyn Fn(NativeAudioStatus) + Send + Sync>) -> Self {
        Self {
            service: AudioService::new(root.clone(), publish),
            root,
            access: Mutex::new(()),
            audition_sequence: AtomicU64::new(0),
            audition_render: Mutex::new(()),
            embedded: Mutex::new(None),
            current_backing: Mutex::new(None),
            protected_paths: ProtectedPaths::default(),
        }
    }
    pub fn with_protected_paths(mut self, protected_paths: ProtectedPaths) -> Self {
        self.protected_paths = protected_paths;
        self
    }
    pub(crate) fn protect_destination(&self, path: &Path) -> Result<(), String> {
        self.protected_paths.check(path)
    }
    pub(crate) fn clear_owner_caches(&self) {
        *self.embedded.lock().unwrap() = None;
        *self.current_backing.lock().unwrap() = None;
    }
    fn check_owner(workspace: &DocumentWorkspace, owner: &AudioOwner) -> Result<(), String> {
        if workspace.active_owner() != owner {
            return Err("Audio owner is no longer active.".into());
        }
        Ok(())
    }
    fn backing(
        settings: &DocumentSettings,
        workspace: &DocumentWorkspace,
        document_id: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        match &settings.backing {
            Some(backing) if backing.asset_id != "embedded" => workspace
                .asset_bytes(document_id, &backing.asset_id)
                .map(Some),
            _ => Ok(None),
        }
    }
    pub(crate) fn prepare(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
        plan: PlaybackPlan,
        settings: DocumentSettings,
        embedded_bytes: Option<Vec<u8>>,
        source_key: String,
        practice: Option<PracticeSettings>,
    ) -> Result<(), String> {
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        let backing = {
            let workspace = workspace.lock().map_err(|e| e.to_string())?;
            Self::check_owner(&workspace, owner)?;
            if workspace.is_frozen() {
                return Err("The workspace is completing a session transition.".into());
            }
            Self::backing(&settings, &workspace, &owner.document_id)?
        };
        if plan.generation == u64::MAX || self.service.status().desired_generation == u64::MAX {
            return Err("Audio generation exhausted; restart TabPlayer before playback.".into());
        }
        settings.validate()?;
        let original = embedded_bytes.or_else(|| {
            self.embedded
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
            backing
        };
        let backing_id = settings.backing.as_ref().map(|b| b.asset_id.clone());
        let generation = plan.generation;
        let result = self.service.prepare_with_practice(
            plan,
            settings,
            backing,
            practice.unwrap_or_default(),
        );
        if result.is_ok() || self.service.prepared_generation() == Some(generation) {
            *self.embedded.lock().unwrap() = original.map(|bytes| (source_key, bytes));
            *self.current_backing.lock().unwrap() = backing_id;
        }
        result
    }
    pub(crate) fn set_mix(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
        settings: DocumentSettings,
        generation: u64,
    ) -> Result<(), String> {
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        let backing = {
            let workspace = workspace.lock().map_err(|e| e.to_string())?;
            Self::check_owner(&workspace, owner)?;
            if workspace.is_frozen() {
                return Err("The workspace is completing a session transition.".into());
            }
            Self::backing(&settings, &workspace, &owner.document_id)?
        };
        settings.validate()?;
        let backing_id = settings.backing.as_ref().map(|b| b.asset_id.clone());
        let mut current_backing = self.current_backing.lock().unwrap();
        if *current_backing == backing_id {
            self.service.set_mix(settings, generation)?;
        } else {
            let backing = if backing_id.as_deref() == Some("embedded") {
                Some(
                    self.embedded
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|(_, bytes)| bytes.clone())
                        .ok_or("Original embedded backing is unavailable; reload the score.")?,
                )
            } else {
                backing
            };
            self.service
                .set_mix_with_backing(settings, generation, backing)?;
            *current_backing = backing_id;
        }
        Ok(())
    }
    fn launch_export(
        &self,
        jobs: &ExportJobs,
        workspace: &Mutex<DocumentWorkspace>,
        document: &DocumentRevision,
        destination: Option<&Path>,
        settings: Option<&DocumentSettings>,
        embedded_bytes: Option<Vec<u8>>,
        total_frames: u64,
    ) -> Result<ExportCapture, String> {
        if let Some(path) = destination {
            self.protect_destination(path)?;
        }
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        let embedded = if settings
            .and_then(|settings| settings.backing.as_ref())
            .is_some_and(|b| b.asset_id == "embedded")
        {
            embedded_bytes.or_else(|| {
                self.embedded
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|(_, bytes)| bytes.clone())
            })
        } else {
            None
        };
        let workspace = workspace.lock().map_err(|e| e.to_string())?;
        crate::validate_export_origin(&workspace, document)?;
        if let Some(path) = destination {
            workspace.protect_destination(document, path)?;
        }
        let backing = match settings {
            Some(settings)
                if settings
                    .backing
                    .as_ref()
                    .is_some_and(|b| b.asset_id == "embedded") =>
            {
                Some(
                    embedded
                        .ok_or("Original embedded backing is unavailable; reload the score.")?,
                )
            }
            Some(settings) => Self::backing(settings, &workspace, &document.document_id)?,
            None => None,
        };
        let projects = workspace
            .snapshot()
            .documents
            .into_iter()
            .map(|d| d.snapshot.project)
            .collect();
        // Publish the owned running slot in the same critical section as capture.
        let job = jobs.start(&document.document_id, total_frames)?;
        Ok(ExportCapture {
            job,
            backing,
            projects,
            protected_paths: self.protected_paths.clone(),
        })
    }

    pub(crate) fn command(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
        command: TransportCommand,
    ) -> Result<(), String> {
        if matches!(command, TransportCommand::Invalidate { .. }) {
            // Owner validation and the atomic invalidation share publication's lock.
            // This path must never wait for access, service control, or cache locks.
            let workspace = workspace.lock().map_err(|e| e.to_string())?;
            Self::check_owner(&workspace, owner)?;
            return self.service.command(command);
        }
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        {
            let workspace = workspace.lock().map_err(|e| e.to_string())?;
            Self::check_owner(&workspace, owner)?;
            if workspace.is_frozen()
                && !matches!(
                    command,
                    TransportCommand::Pause { .. } | TransportCommand::Stop { .. }
                )
            {
                return Err("The workspace is completing a session transition.".into());
            }
        }
        self.service.command(command)
    }

    /// Play a short note or chord through the request's own sound. Only the workspace
    /// lock is taken, like `Invalidate`: never `access` or the service `control` lock
    /// that a prepare holds, and not tied to the plan generation, so an audition works
    /// while a re-prepare is pending. A frozen workspace refuses with the same error
    /// as the other audio work. The clip is rendered outside every lock and the owner
    /// is checked again when it is queued.
    ///
    /// Requests are numbered once admitted (valid, owned, and with a stream to play
    /// on) and rendered one at a time; a request that a newer one has overtaken stops
    /// waiting and skips its render, and an overtaken render is dropped instead of
    /// queued, so the latest request always wins and renders never pile up.
    ///
    /// Not handled (out of scope): a clip already sounding when the active document
    /// changes plays out its few hundred milliseconds rather than being cancelled.
    pub(crate) fn audition(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
        request: AuditionRequest,
    ) -> Result<AuditionResult, String> {
        self.audition_with(workspace, owner, request, |request, rate| {
            render_clip(&self.root, request, rate)
        })
    }

    fn check_audition_owner<'a>(
        workspace: &'a Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
    ) -> Result<std::sync::MutexGuard<'a, DocumentWorkspace>, String> {
        let workspace = workspace.lock().map_err(|e| e.to_string())?;
        Self::check_owner(&workspace, owner)?;
        if workspace.is_frozen() {
            return Err("The workspace is completing a session transition.".into());
        }
        Ok(workspace)
    }

    pub(crate) fn audition_with(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
        request: AuditionRequest,
        render: impl FnOnce(&AuditionRequest, u32) -> Result<Box<AuditionClip>, String>,
    ) -> Result<AuditionResult, String> {
        request.validate()?;
        drop(Self::check_audition_owner(workspace, owner)?);
        let not_played = Ok(AuditionResult { played: false });
        let Some(rate) = self.service.audition_rate() else {
            return not_played;
        };
        // Only a request that could play overtakes the ones before it.
        let sequence = self.audition_sequence.fetch_add(1, Ordering::SeqCst) + 1;
        let superseded = || self.audition_sequence.load(Ordering::SeqCst) != sequence;
        // An overtaken request gives up while it waits, so a stalled render holds
        // at most one waiting thread. The lock guards no data, so poison is ignored.
        let _rendering = loop {
            if superseded() {
                return not_played;
            }
            match self.audition_render.try_lock() {
                Ok(guard) => break guard,
                Err(TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
            }
        };
        if superseded() {
            return not_played;
        }
        let clip = render(&request, rate)?;
        let workspace = Self::check_audition_owner(workspace, owner)?;
        if superseded() {
            return not_played;
        }
        let played = self.service.submit_audition(clip);
        drop(workspace);
        Ok(AuditionResult { played })
    }
}

#[tauri::command]
pub async fn audio_prepare(
    owner: AudioOwner,
    plan: PlaybackPlan,
    settings: DocumentSettings,
    embedded_bytes: Option<Vec<u8>>,
    source_key: String,
    practice: Option<PracticeSettings>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAudio>().prepare(
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &owner,
            plan,
            settings,
            embedded_bytes,
            source_key,
            practice,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn audio_set_mix(
    owner: AudioOwner,
    settings: DocumentSettings,
    generation: u64,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAudio>().set_mix(
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &owner,
            settings,
            generation,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn audio_command(
    owner: AudioOwner,
    command: TransportCommand,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAudio>().command(
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &owner,
            command,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn audio_audition(
    owner: AudioOwner,
    request: AuditionRequest,
    app: AppHandle,
) -> Result<AuditionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<NativeAudio>().audition(
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &owner,
            request,
        )
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
    document_id: &str,
    workspace: &Mutex<DocumentWorkspace>,
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
    let staged = workspace.lock().unwrap().stage_asset(document_id, asset)?;
    let mut result = serde_json::to_value(staged).map_err(|e| e.to_string())?;
    result["durationMs"] = serde_json::json!(duration_ms);
    Ok(result)
}
#[tauri::command]
pub async fn stage_backing(
    document_id: String,
    app: AppHandle,
) -> Result<Option<serde_json::Value>, String> {
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
        stage_audio(
            bytes,
            filename,
            &document_id,
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
        )
        .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn stage_embedded_backing(
    document_id: String,
    bytes: Vec<u8>,
    app: AppHandle,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stage_audio(
            bytes,
            "Embedded backing.audio".into(),
            &document_id,
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn cancel_asset(
    document_id: String,
    token: String,
    workspace: State<'_, Arc<Mutex<DocumentWorkspace>>>,
) -> Result<bool, String> {
    workspace.lock().unwrap().cancel_asset(&document_id, &token)
}

fn export_destination(
    app: &AppHandle,
    extension: &str,
    folder: bool,
    file_name: Option<&str>,
) -> Result<Option<PathBuf>, String> {
    let name = crate::suggested_name(
        file_name,
        if folder {
            "TabPlayer-stems"
        } else {
            "TabPlayer-export"
        },
    );
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        // A test folder stands in for the folder the user would pick, so the suggested name decides the file.
        let path = match std::env::var_os("TABPLAYER_TEST_EXPORT_DIR") {
            Some(directory) => PathBuf::from(directory).join(&name),
            None => std::env::var_os("TABPLAYER_TEST_EXPORT")
                .map(PathBuf::from)
                .ok_or("Test export destination is missing.")?,
        };
        // Append the extension the way the save dialog path does, so dotted names survive.
        return Ok(Some(if folder {
            path
        } else {
            crate::with_extension(path, extension)
        }));
    }
    let selected = app
        .dialog()
        .file()
        .set_file_name(&name)
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
    document: DocumentRevision,
    bytes: Vec<u8>,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    let Some(path) = export_destination(&app, "mid", false, file_name.as_deref())? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::export_document_to_path(
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            &path,
            &bytes,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_musicxml(
    document: DocumentRevision,
    bytes: Vec<u8>,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    let Some(path) = export_destination(&app, "musicxml", false, file_name.as_deref())? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::export_document_to_path(
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            &path,
            &bytes,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_ascii_tab(
    document: DocumentRevision,
    bytes: Vec<u8>,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    if std::str::from_utf8(&bytes).is_err() {
        return Err("ASCII tablature must be UTF-8 text.".into());
    }
    let Some(path) = export_destination(&app, "txt", false, file_name.as_deref())? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        crate::export_document_to_path(
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            &path,
            &bytes,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_svg(
    document: DocumentRevision,
    pages: Vec<SvgPage>,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    let Some(path) = export_destination(&app, "svg", false, file_name.as_deref())? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Convert every page before writing, so a refusal leaves no partial set behind.
        let files = crate::export::svg::convert_pages(&pages)?;
        let paths = crate::export::svg::page_paths(&path, files.len());
        let outputs: Vec<_> = paths
            .iter()
            .zip(&files)
            .map(|(path, svg)| (path.as_path(), svg.as_bytes()))
            .collect();
        crate::export_document_files(
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            &outputs,
            false,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_png(
    document: DocumentRevision,
    pages: Vec<SvgPage>,
    dpi: u32,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    let Some(path) = export_destination(&app, "png", false, file_name.as_deref())? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        // Render every page before writing, so a refusal leaves no partial set behind.
        let files = crate::export::png::render_pages(&pages, dpi)?;
        let paths = crate::export::svg::page_paths(&path, files.len());
        let outputs: Vec<_> = paths
            .iter()
            .zip(&files)
            .map(|(path, png)| (path.as_path(), png.as_slice()))
            .collect();
        crate::export_document_files(
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            &outputs,
            false,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// The folder for one file per track. Nothing in it was confirmed, so every file must be new.
fn export_folder(app: &AppHandle) -> Result<Option<PathBuf>, String> {
    #[cfg(feature = "desktop-test")]
    if std::env::var("TABPLAYER_DESKTOP_TEST").as_deref() == Ok("1") {
        return std::env::var_os("TABPLAYER_TEST_EXPORT_DIR")
            .map(|folder| Some(PathBuf::from(folder)))
            .ok_or_else(|| "Test export folder is missing.".to_string());
    }
    app.dialog()
        .file()
        .blocking_pick_folder()
        .map(|folder| folder.into_path().map_err(|e| e.to_string()))
        .transpose()
}
#[tauri::command]
pub async fn export_track_files(
    document: DocumentRevision,
    format: String,
    files: Vec<crate::export::tracks::TrackPages>,
    dpi: Option<u32>,
    app: AppHandle,
) -> Result<bool, String> {
    let Some(folder) = export_folder(&app)? else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || {
        let outputs = crate::export::tracks::track_files(&folder, &format, &files, dpi)?;
        let outputs: Vec<_> = outputs
            .iter()
            .map(|(path, bytes)| (path.as_path(), bytes.as_slice()))
            .collect();
        crate::export_document_files(
            &app.state::<NativeAudio>(),
            &app.state::<ExportJobs>(),
            &app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            &outputs,
            true,
        )?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn export_pdf(
    document: DocumentRevision,
    pages: Vec<SvgPage>,
    print: bool,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    let destination = if print {
        None
    } else {
        let Some(path) = export_destination(&app, "pdf", false, file_name.as_deref())? else {
            return Ok(None);
        };
        Some(path)
    };
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("print");
    let launch_app = app.clone();
    let launch_destination = destination.clone();
    let launch_cache = cache.clone();
    let total = pages.len() as u64;
    let capture = tauri::async_runtime::spawn_blocking(move || {
        let audio = launch_app.state::<NativeAudio>();
        if launch_destination.is_none() {
            audio.protect_destination(&launch_cache)?;
        }
        audio.launch_export(
            &launch_app.state::<ExportJobs>(),
            &launch_app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            launch_destination.as_deref(),
            None,
            None,
            total,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let id = capture.job.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let job = &capture.job;
        let result = (|| {
            let bytes =
                crate::export::pdf::convert_pages_with_progress(&pages, &job.cancel, |frames| {
                    job.progress(frames)
                })?;
            if job.cancel.load(std::sync::atomic::Ordering::Acquire) {
                return Err("PDF export cancelled.".into());
            }
            if let Some(path) = destination {
                capture.protect_destination(&path)?;
                crate::files::write_bytes(&path, &bytes)?;
            } else {
                let cache = capture.print_cache(&cache)?;
                crate::export::print::prepare_and_open(&bytes, &cache)?;
            }
            Ok(())
        })();
        job.finish(result);
    });
    Ok(Some(id))
}
fn export_source_settings(include: bool, settings: &DocumentSettings) -> Option<&DocumentSettings> {
    (include
        || settings
            .backing
            .as_ref()
            .is_some_and(|backing| backing.reference_sync.is_some()))
    .then_some(settings)
}

fn prepare_export_backing(
    plan: &PlaybackPlan,
    settings: &DocumentSettings,
    bytes: Option<Vec<u8>>,
    include: bool,
) -> Result<Option<(Arc<DecodedAudio>, BackingMap)>, String> {
    let reference = settings
        .backing
        .as_ref()
        .is_some_and(|backing| backing.reference_sync.is_some());
    if reference != plan.playback_end_tick.is_some() {
        return Err("Reference export timing requires matching source settings.".into());
    }
    if !include && !reference {
        return Ok(None);
    }
    let Some(backing) = settings.backing.as_ref() else {
        return Ok(None);
    };
    let bytes = match bytes {
        Some(bytes) => bytes,
        None if reference => return Err("Reference export source audio is missing.".into()),
        None => return Ok(None),
    };
    let audio = Arc::new(decode_audio(&bytes, None)?);
    if reference {
        ReferenceSyncMap::new(backing, plan)?.validate_audio(&audio)?;
    }
    if !include {
        return Ok(None);
    }
    let map = BackingMap::from_settings(backing, plan)?;
    Ok(Some((audio, map)))
}

#[tauri::command]
pub async fn export_audio(
    document: DocumentRevision,
    plan: PlaybackPlan,
    request: AudioExportRequest,
    mut settings: DocumentSettings,
    embedded_bytes: Option<Vec<u8>>,
    stems: bool,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<Option<String>, String> {
    settings.validate()?;
    request.format.validate()?;
    if let Some(level) = request.normalize_rms_db {
        if stems {
            return Err("Normalization applies to mixed audio only.".into());
        }
        if !crate::export::wav::NORMALIZE_RMS_DB.contains(&level) {
            return Err("Choose a normalization level from -30 to -6 dB RMS.".into());
        }
    }
    crate::export::audio::RenderSchedule::new(
        &plan,
        request.range,
        request.format.sample_rate,
        request.speed,
        request.tail_seconds,
        plan.duration_ms / 1000.0,
    )?;
    let Some(path) = export_destination(
        &app,
        request.format.container.extension(),
        stems,
        file_name.as_deref(),
    )?
    else {
        return Ok(None);
    };
    let launch_app = app.clone();
    let launch_path = path.clone();
    let launch_settings = settings.clone();
    let include_backing = request.include_backing;
    let (mut capture, root) = tauri::async_runtime::spawn_blocking(move || {
        let audio = launch_app.state::<NativeAudio>();
        if stems {
            audio
                .protect_destination(launch_path.parent().ok_or("Choose a new stem directory.")?)?;
        }
        let captured = audio.launch_export(
            &launch_app.state::<ExportJobs>(),
            &launch_app.state::<Arc<Mutex<DocumentWorkspace>>>(),
            &document,
            Some(&launch_path),
            export_source_settings(include_backing, &launch_settings),
            embedded_bytes,
            0,
        )?;
        Ok::<_, String>((captured, audio.root.clone()))
    })
    .await
    .map_err(|e| e.to_string())??;
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
    let id = capture.job.id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let backing_audio = prepare_export_backing(
                &plan,
                &settings,
                capture.backing.take(),
                request.include_backing,
            )?;
            if !request.include_backing {
                settings.backing = None;
            }
            let resources = Arc::new(AudioResources::load_for_requests(
                &root,
                &resource_requests(&plan, &settings),
            )?);
            if capture
                .job
                .cancel
                .load(std::sync::atomic::Ordering::Acquire)
            {
                return Err("Audio export cancelled.".into());
            }
            let mut renderer = Renderer::new(
                Arc::new(plan.clone()),
                resources,
                settings.clone(),
                request.format.sample_rate,
            )?;
            if let Some((audio, map)) = backing_audio {
                let backing = settings
                    .backing
                    .as_ref()
                    .ok_or("Backing settings are missing.")?;
                renderer.install_processed_backing(
                    audio,
                    map,
                    backing.mix.clone(),
                    backing.processing.clone().unwrap_or_default(),
                )?;
            }
            let format = request.format;
            let normalize = request.normalize_rms_db;
            let mut render = AudioExportRender::new(renderer, &plan, request)?;
            let job = &capture.job;
            // Normalizing renders the audio and then writes it, so its progress counts both passes.
            job.total_frames(render.total_frames() * if normalize.is_some() { 2 } else { 1 });
            if stems {
                capture.protect_stem_destination(&path)?;
                crate::export::stems::write_stems(
                    &path,
                    &render.stem_spec(),
                    |output| render.render_stems(output),
                    &job.cancel,
                    |frames| job.progress(frames),
                )?;
            } else if let Some(level) = normalize {
                capture.protect_destination(&path)?;
                crate::export::wav::write_normalized_wav(
                    &path,
                    format,
                    level,
                    |output| render.render_mix(output),
                    &job.cancel,
                    |frames| job.progress(frames),
                )?;
            } else {
                capture.protect_destination(&path)?;
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
        capture.job.finish(result);
    });
    Ok(Some(id))
}
#[tauri::command]
pub fn export_status(
    document_id: String,
    id: String,
    jobs: State<'_, ExportJobs>,
) -> Option<ExportProgress> {
    jobs.status(&document_id, &id)
}
#[tauri::command]
pub fn cancel_export(
    document_id: String,
    id: String,
    jobs: State<'_, ExportJobs>,
) -> Result<(), String> {
    jobs.cancel(&document_id, &id)
}
