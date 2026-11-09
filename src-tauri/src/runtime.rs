use crate::{
    assets::StoredAsset,
    audio::{
        audition::{AuditionClip, AuditionRequest, AuditionResult, render_clip},
        backing::BackingMap,
        decode::{DecodedAudio, decode_audio},
        device::{
            AudioDeviceInfo, AudioDiagnostics, AudioService, NativeAudioStatus, PracticeSettings,
            TransportCommand,
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

/// What the mix was last built from, so the plug-in tick can build it again (review H1, H2 of Task 13).
#[derive(Clone)]
struct PluginMemo {
    owner: AudioOwner,
    settings: DocumentSettings,
    generation: u64,
    /// The largest device callback the mix's pipeline was sized for.
    frames: u32,
    /// The device rate the plug-ins were asked to run at.
    rate: Option<u32>,
    /// Counts the builds: a tick re-runs only the build it read.
    version: u64,
    has_plugins: bool,
}

pub struct NativeAudio {
    pub service: AudioService,
    pub root: PathBuf,
    pub plugins: Option<Arc<crate::plugins::service::PluginService>>,
    pub(crate) access: Mutex<()>,
    audition_sequence: AtomicU64,
    audition_render: Mutex<()>,
    embedded: Mutex<Option<(String, Vec<u8>)>>,
    current_backing: Mutex<Option<String>>,
    protected_paths: ProtectedPaths,
    plugin_memo: Mutex<Option<PluginMemo>>,
    /// Held from asking for the plug-ins until the mix is built, by prepares, mix changes and the plug-in tick alike, so
    /// the last one to ask is the one whose states the helpers keep (review M-A).
    mix: Mutex<()>,
    /// Set at exit: the plug-in tick does nothing more (review L2).
    tick_stopped: std::sync::atomic::AtomicBool,
    /// A device for the tests: its rate and its largest callback.
    #[cfg(test)]
    test_device: Mutex<Option<(Option<u32>, u32)>>,
    /// Runs inside a tick, just before it asks for the plug-ins, so a test can act in that moment.
    #[cfg(test)]
    tick_pause: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    /// While set, a built mix is recorded here instead of being installed in the audio service.
    #[cfg(test)]
    test_mixes: Mutex<Option<Vec<TestMix>>>,
}

/// A mix a test recorded in place of the audio service.
#[cfg(test)]
pub(crate) struct TestMix {
    settings: DocumentSettings,
    plans: Vec<(
        String,
        Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
    )>,
    frames: u32,
}

/// Whether any active plug-in slot is in `settings`.
fn has_plugins(settings: &DocumentSettings) -> bool {
    settings
        .sounds
        .values()
        .any(|sound| sound.plugin.as_ref().is_some_and(|slot| slot.active))
}
impl NativeAudio {
    pub fn new(root: PathBuf, publish: Arc<dyn Fn(NativeAudioStatus) + Send + Sync>) -> Self {
        Self {
            service: AudioService::new(root.clone(), publish),
            root,
            plugins: None,
            access: Mutex::new(()),
            audition_sequence: AtomicU64::new(0),
            audition_render: Mutex::new(()),
            embedded: Mutex::new(None),
            current_backing: Mutex::new(None),
            protected_paths: ProtectedPaths::default(),
            plugin_memo: Mutex::new(None),
            mix: Mutex::new(()),
            tick_stopped: std::sync::atomic::AtomicBool::new(false),
            #[cfg(test)]
            test_device: Mutex::new(None),
            #[cfg(test)]
            tick_pause: Mutex::new(None),
            #[cfg(test)]
            test_mixes: Mutex::new(None),
        }
    }
    /// The output device's sample rate, or None while no stream is open.
    fn device_rate(&self) -> Option<u32> {
        #[cfg(test)]
        if let Some((rate, _)) = *self.test_device.lock().unwrap() {
            return rate;
        }
        self.service.audition_rate()
    }
    /// The largest callback the device has asked for, as the audio service sizes pipelines from it.
    fn callback_frames(&self) -> u32 {
        #[cfg(test)]
        if let Some((_, frames)) = *self.test_device.lock().unwrap() {
            return frames;
        }
        self.service.max_callback_frames().unwrap_or(512)
    }
    /// Asks the plug-in service for the document's inserts at the device's rate, and refuses, before the mix is built,
    /// every plan the renderer would refuse: the renderer drops such an insert without a word (review M1 of Task 13), so
    /// the slot is told why here. A plan for another rate (the device changed in between) waits for the next tick.
    fn plugin_plans(
        &self,
        document_id: &str,
        requests: &[crate::plugins::service::SlotRequest],
    ) -> (
        Vec<(
            String,
            Result<crate::plugins::service::InsertPlan, crate::plugins::status::PluginStatus>,
        )>,
        Option<u32>,
        u32,
    ) {
        use crate::audio::plugin_insert::{InsertError, InsertMode, PluginInsert};
        use crate::plugins::status::PluginStatus;
        let rate = self.device_rate();
        let frames = self.callback_frames();
        let Some(plugins) = &self.plugins else {
            return (Vec::new(), rate, frames);
        };
        let mode = InsertMode::Realtime {
            pipeline_frames: tabplayer_plugin_protocol::limits::pipeline_frames(frames as usize),
        };
        let plans = plugins
            .ensure(document_id, rate, requests)
            .into_iter()
            .map(|(track_id, plan)| {
                let plan = match (plan, rate) {
                    (Ok(plan), Some(rate)) => {
                        match PluginInsert::check(plan.link.sample_rate(), mode, plan.latency, rate)
                        {
                            Ok(()) => {
                                plugins.clear_refusal(document_id, &track_id);
                                Ok(plan)
                            }
                            Err(InsertError::RateMismatch) => {
                                plugins.request_reprepare(document_id);
                                Err(PluginStatus::Loading)
                            }
                            Err(InsertError::TooMuchLatency) => {
                                plugins.record_refusal(
                                    document_id,
                                    &track_id,
                                    PluginStatus::TooMuchLatency,
                                );
                                Err(PluginStatus::TooMuchLatency)
                            }
                            Err(InsertError::PipelineTooLong) => {
                                // The device's callback is longer than any pipeline the insert can keep up with.
                                plugins.record_refusal(
                                    document_id,
                                    &track_id,
                                    PluginStatus::Underrun,
                                );
                                Err(PluginStatus::Underrun)
                            }
                        }
                    }
                    (plan, _) => plan,
                };
                (track_id, plan)
            })
            .collect();
        (plans, rate, frames)
    }
    /// Tells the slots about the inserts the audio service's build refused, in the words `plugin_plans` uses for the same
    /// refusals: the device can change between that check and the build. A helper at another rate is not the plug-in's
    /// fault, so it asks for the mix to be built again at the device's rate instead.
    pub(crate) fn report_insert_refusals(
        &self,
        document_id: &str,
        refusals: Vec<(String, crate::audio::plugin_insert::InsertError)>,
    ) {
        use crate::audio::plugin_insert::InsertError;
        use crate::plugins::status::PluginStatus;
        let Some(plugins) = &self.plugins else {
            return;
        };
        for (track_id, error) in refusals {
            match error {
                InsertError::RateMismatch => plugins.request_reprepare(document_id),
                InsertError::TooMuchLatency => {
                    plugins.record_refusal(document_id, &track_id, PluginStatus::TooMuchLatency)
                }
                InsertError::PipelineTooLong => {
                    plugins.record_refusal(document_id, &track_id, PluginStatus::Underrun)
                }
            }
        }
    }
    /// Records what the mix was just built from. Called with the access lock held.
    fn remember_mix(
        &self,
        owner: &AudioOwner,
        settings: DocumentSettings,
        generation: u64,
        frames: u32,
        rate: Option<u32>,
    ) {
        let mut memo = self.plugin_memo.lock().unwrap();
        let version = memo.as_ref().map_or(0, |memo| memo.version + 1);
        *memo = Some(PluginMemo {
            owner: owner.clone(),
            has_plugins: has_plugins(&settings),
            settings,
            generation,
            frames,
            rate,
            version,
        });
    }
    /// Builds the mix again when the plug-in service asks for it (a helper became ready or faulted, or announced a new
    /// latency), when the device's largest callback grew past the pipeline the mix was sized for, or when the device's
    /// rate changed. Returns whether it tried. The app calls it every 100 ms from its own thread.
    pub(crate) fn plugin_tick(&self, workspace: &Mutex<DocumentWorkspace>) -> bool {
        use tabplayer_plugin_protocol::limits::pipeline_frames;
        let Some(plugins) = &self.plugins else {
            return false;
        };
        // Held until the mix is built: a prepare or an undo's mix change that comes meanwhile waits, and then asks for
        // its own states last (review M-A).
        let _mix = self.mix.lock().unwrap();
        if self.tick_stopped.load(Ordering::SeqCst) {
            return false;
        }
        let Some(memo) = self.plugin_memo.lock().unwrap().clone() else {
            return false;
        };
        // During a session transition nothing can be built: a request stays for the tick after it.
        let active = match workspace.lock() {
            Ok(workspace) if workspace.is_frozen() => return false,
            Ok(workspace) => workspace.active_owner() == &memo.owner,
            Err(_) => return false,
        };
        let asked = plugins.take_reprepare(&memo.owner.document_id);
        if !memo.has_plugins {
            return false;
        }
        let frames = self.callback_frames();
        let rate = self.device_rate();
        let grew = pipeline_frames(frames as usize) > pipeline_frames(memo.frames as usize);
        if !asked && !grew && rate == memo.rate {
            return false;
        }
        // Nothing for a document that is no longer the active one (switched or closed): it would start helpers that
        // nothing shuts down (review M-A).
        if !active {
            return false;
        }
        #[cfg(test)]
        if let Some(pause) = self.tick_pause.lock().unwrap().take() {
            pause();
        }
        let result = self.build_mix(
            workspace,
            &memo.owner,
            memo.settings.clone(),
            memo.generation,
            Some(memo.version),
        );
        if result.is_err() {
            // Not again on every tick: only when something changes once more.
            let mut guard = self.plugin_memo.lock().unwrap();
            if let Some(current) = guard.as_mut().filter(|m| m.version == memo.version) {
                current.frames = current.frames.max(frames);
                current.rate = rate;
            }
        }
        true
    }
    /// Stops the plug-in tick for good, for the app's exit (review L2): no tick starts after it. It does not wait for a
    /// tick already running, which may be waiting on a plug-in, so the exit is never held up; the helpers such a tick
    /// starts end with the app's job object.
    pub(crate) fn stop_plugin_tick(&self) {
        self.tick_stopped.store(true, Ordering::SeqCst);
    }
    pub(crate) fn plugin_tick_stopped(&self) -> bool {
        self.tick_stopped.load(Ordering::SeqCst)
    }
    /// Shuts the document's helpers down when it is no longer the active one: a prepare for it asked for its plug-ins
    /// after it was switched away or closed, and nothing else would end them (review M-A).
    fn release_inactive(&self, workspace: &Mutex<DocumentWorkspace>, owner: &AudioOwner) {
        let Some(plugins) = &self.plugins else {
            return;
        };
        let active = workspace
            .lock()
            .map(|workspace| workspace.active_owner().document_id == owner.document_id)
            .unwrap_or(true);
        if !active {
            plugins.shutdown_document(&owner.document_id);
        }
    }
    pub fn with_plugins(mut self, plugins: Arc<crate::plugins::service::PluginService>) -> Self {
        self.plugins = Some(plugins);
        self
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
        let _mix = self.mix.lock().map_err(|e| e.to_string())?;
        let slot_requests: Vec<crate::plugins::service::SlotRequest> = {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            plan.tracks
                .iter()
                .filter_map(|t| {
                    let slot = settings.sounds.get(&t.id).and_then(|s| s.plugin.clone())?;
                    let bytes = ws
                        .asset_bytes(&owner.document_id, &slot.state)
                        .unwrap_or_default();
                    Some(crate::plugins::service::SlotRequest {
                        track_id: t.id.clone(),
                        slot,
                        state: bytes.into(),
                    })
                })
                .collect()
        };
        let (plugin_plans, rate, frames) = self.plugin_plans(&owner.document_id, &slot_requests);
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        let backing = {
            let workspace_guard = workspace.lock().map_err(|e| e.to_string())?;
            if let Err(error) = Self::check_owner(&workspace_guard, owner) {
                drop(workspace_guard);
                self.release_inactive(workspace, owner);
                return Err(error);
            }
            if workspace_guard.is_frozen() {
                return Err("The workspace is completing a session transition.".into());
            }
            Self::backing(&settings, &workspace_guard, &owner.document_id)?
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
        let memo_settings = settings.clone();
        let result = self.service.prepare_with_practice_and_plugins(
            plan,
            settings,
            backing,
            practice.unwrap_or_default(),
            plugin_plans,
        );
        self.report_insert_refusals(&owner.document_id, self.service.take_plugin_refusals());
        if result.is_ok() {
            self.remember_mix(owner, memo_settings, generation, frames, rate);
        }
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
        let _mix = self.mix.lock().map_err(|e| e.to_string())?;
        self.build_mix(workspace, owner, settings, generation, None)
    }
    /// `set_mix`, with the mix lock held by the caller; with `only_version`, only while the last build is still that one,
    /// so a tick never undoes a newer change.
    fn build_mix(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
        settings: DocumentSettings,
        generation: u64,
        only_version: Option<u64>,
    ) -> Result<(), String> {
        let slot_requests: Vec<crate::plugins::service::SlotRequest> = {
            let ws = workspace.lock().map_err(|e| e.to_string())?;
            if let Some(track_ids) = self.service.prepared_track_ids() {
                track_ids
                    .iter()
                    .filter_map(|track_id| {
                        let sound = settings.sounds.get(track_id)?;
                        let slot = sound.plugin.clone()?;
                        let bytes = ws
                            .asset_bytes(&owner.document_id, &slot.state)
                            .unwrap_or_default();
                        Some(crate::plugins::service::SlotRequest {
                            track_id: track_id.clone(),
                            slot,
                            state: bytes.into(),
                        })
                    })
                    .collect()
            } else {
                settings
                    .sounds
                    .iter()
                    .filter_map(|(track_id, sound)| {
                        let slot = sound.plugin.clone()?;
                        let bytes = ws
                            .asset_bytes(&owner.document_id, &slot.state)
                            .unwrap_or_default();
                        Some(crate::plugins::service::SlotRequest {
                            track_id: track_id.clone(),
                            slot,
                            state: bytes.into(),
                        })
                    })
                    .collect()
            }
        };
        let (plugin_plans, rate, frames) = self.plugin_plans(&owner.document_id, &slot_requests);
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        if let Some(version) = only_version {
            if self
                .plugin_memo
                .lock()
                .unwrap()
                .as_ref()
                .is_none_or(|memo| memo.version != version)
            {
                return Ok(());
            }
        }
        let memo_settings = settings.clone();
        let backing_id = settings.backing.as_ref().map(|b| b.asset_id.clone());
        // The asset is decoded only when the backing is changing: a mix change with the same backing never uses its bytes, and
        // decoding a long recording on every change of a knob would hold the workspace lock for no result.
        let backing_changes = *self.current_backing.lock().unwrap() != backing_id;
        let backing = {
            let workspace_guard = workspace.lock().map_err(|e| e.to_string())?;
            if let Err(error) = Self::check_owner(&workspace_guard, owner) {
                drop(workspace_guard);
                self.release_inactive(workspace, owner);
                return Err(error);
            }
            if workspace_guard.is_frozen() {
                return Err("The workspace is completing a session transition.".into());
            }
            if backing_changes {
                Self::backing(&settings, &workspace_guard, &owner.document_id)?
            } else {
                None
            }
        };
        settings.validate()?;
        let mut current_backing = self.current_backing.lock().unwrap();
        #[cfg(test)]
        if let Some(mixes) = self.test_mixes.lock().unwrap().as_mut() {
            mixes.push(TestMix {
                settings,
                plans: plugin_plans,
                frames,
            });
            drop(current_backing);
            self.remember_mix(owner, memo_settings, generation, frames, rate);
            return Ok(());
        }
        if *current_backing == backing_id {
            self.service
                .set_mix_with_plugins(settings, generation, plugin_plans)?;
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
            self.service.set_mix_with_backing_and_plugins(
                settings,
                generation,
                backing,
                plugin_plans,
            )?;
            *current_backing = backing_id;
        }
        self.report_insert_refusals(&owner.document_id, self.service.take_plugin_refusals());
        self.remember_mix(owner, memo_settings, generation, frames, rate);
        Ok(())
    }
    /// Tries again the MIDI ports the open score sends tracks to that were not working. For the owner of the score only.
    pub(crate) fn midi_refresh(
        &self,
        workspace: &Mutex<DocumentWorkspace>,
        owner: &AudioOwner,
    ) -> Result<(), String> {
        let _access = self.access.lock().map_err(|e| e.to_string())?;
        {
            let workspace = workspace.lock().map_err(|e| e.to_string())?;
            Self::check_owner(&workspace, owner)?;
        }
        self.service.midi_refresh();
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
#[tauri::command]
pub async fn audio_diagnostics(app: AppHandle) -> Result<AudioDiagnostics, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<NativeAudio>().service.diagnostics())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn audio_test_tone(audio: State<'_, NativeAudio>) -> Result<(), String> {
    audio.service.test_tone()
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
    // A finalized document refuses backing import before any file picker opens.
    app.state::<Arc<Mutex<DocumentWorkspace>>>()
        .lock()
        .unwrap()
        .check_unlocked(&document_id)?;
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
/// Writes a Guitar Pro 5 file the frontend built. Anything that is not one is refused before a destination is asked for.
#[tauri::command]
pub async fn export_gp5(
    document: DocumentRevision,
    bytes: Vec<u8>,
    file_name: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    check_gp5(&bytes)?;
    let Some(path) = export_destination(&app, "gp5", false, file_name.as_deref())? else {
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
/// A Guitar Pro 5 file starts with a length byte and the text of its version; a zip (Guitar Pro 7 and later) does not.
fn check_gp5(bytes: &[u8]) -> Result<(), String> {
    const VERSION: &[u8] = b"FICHIER GUITAR PRO v5.";
    if bytes.len() < 32 || bytes[0] as usize != 24 || !bytes[1..].starts_with(VERSION) {
        return Err("The data is not a Guitar Pro 5 file.".into());
    }
    Ok(())
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
    let document_id = document.document_id.clone();
    let export_doc_id = document.document_id.clone();
    let selected_track_ids: Vec<String> = request.tracks.iter().map(|t| t.id.clone()).collect();
    let plan_tracks_for_slots = plan.tracks.clone();
    let (mut capture, root, slot_requests, plugin_service) =
        tauri::async_runtime::spawn_blocking(move || {
            let audio = launch_app.state::<NativeAudio>();
            if stems {
                audio.protect_destination(
                    launch_path.parent().ok_or("Choose a new stem directory.")?,
                )?;
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
            let plugin_service = audio.plugins.clone().or_else(|| {
                launch_app
                    .try_state::<Arc<crate::plugins::service::PluginService>>()
                    .map(|s| s.inner().clone())
            });
            let workspace_state = launch_app.state::<Arc<Mutex<DocumentWorkspace>>>();
            let ws = workspace_state.lock().map_err(|e| e.to_string())?;
            let slot_requests = plan_tracks_for_slots
                .iter()
                .filter(|t| selected_track_ids.iter().any(|id| id == &t.id))
                .filter_map(|track| {
                    let sound = launch_settings.sounds.get(&track.id)?;
                    let slot = sound.plugin.clone()?;
                    let bytes = ws
                        .asset_bytes(&document_id, &slot.state)
                        .unwrap_or_default();
                    Some(crate::plugins::service::SlotRequest {
                        track_id: track.id.clone(),
                        slot,
                        state: bytes.into(),
                    })
                })
                .collect::<Vec<_>>();
            Ok::<_, String>((captured, audio.root.clone(), slot_requests, plugin_service))
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
            let offline_plugins = if let Some(plugins) = &plugin_service {
                if !slot_requests.is_empty() {
                    let offline = plugins
                        .offline_inserts(&export_doc_id, &slot_requests, request.format.sample_rate)
                        .map_err(|e| e.to_string())?;
                    capture.job.warnings(offline.warnings.clone());
                    Some(offline)
                } else {
                    None
                }
            } else {
                None
            };
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
            let mut render =
                AudioExportRender::new_with_plugins(renderer, &plan, request, offline_plugins)?;
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

#[cfg(test)]
mod gp5_tests {
    use super::check_gp5;

    fn header(text: &[u8]) -> Vec<u8> {
        let mut bytes = vec![text.len() as u8];
        bytes.extend_from_slice(text);
        bytes.resize(31, 0);
        bytes.extend_from_slice(&[0; 8]);
        bytes
    }

    #[test]
    fn only_a_guitar_pro_5_header_is_accepted() {
        assert!(check_gp5(&header(b"FICHIER GUITAR PRO v5.10")).is_ok());
        assert!(check_gp5(&header(b"FICHIER GUITAR PRO v5.00")).is_ok());
        assert!(check_gp5(&header(b"FICHIER GUITAR PRO v4.06")).is_err());
        assert!(check_gp5(b"PK\x03\x04 a Guitar Pro 7 archive, not a Guitar Pro 5 file").is_err());
        assert!(check_gp5(&[]).is_err());
        assert!(check_gp5(&header(b"FICHIER GUITAR PRO v5.10")[..20]).is_err());
    }
}

#[cfg(test)]
mod plugin_tick_tests {
    //! The plug-in tick builds the mix again when it must, and only then (review H1, H2 and M1 of Task 13). Nothing is
    //! prepared in these tests, so the audio service refuses the mix it is given; what is checked is that the tick asked
    //! the plug-in service for its inserts again, at the device's rate.
    use super::*;
    use crate::{
        edit_types::EditCommand,
        plugins::{
            service::fakes::*,
            state::{STATE_FILENAME, STATE_MEDIA_TYPE, encode_state},
            status::PluginStatus,
        },
        settings::TrackSound,
    };
    use std::sync::atomic::Ordering;
    use std::time::Instant;

    struct Tick {
        audio: NativeAudio,
        workspace: Mutex<DocumentWorkspace>,
        rig: TestRig,
        owner: AudioOwner,
        sound: TrackSound,
    }

    impl Tick {
        /// Waits for the helper the tick started, and takes the re-prepare its readiness asks for.
        fn settle(&self) {
            assert_eq!(
                wait_for_slot(&self.rig.service, &self.owner.document_id, "base/0"),
                PluginStatus::Ready
            );
            assert!(self.rig.service.take_reprepare(&self.owner.document_id));
        }

        fn device(&self, rate: Option<u32>, frames: u32) {
            *self.audio.test_device.lock().unwrap() = Some((rate, frames));
        }

        fn launches(&self) -> Vec<u32> {
            let start = Instant::now();
            while start.elapsed() < Duration::from_millis(100) {
                std::thread::sleep(Duration::from_millis(5));
            }
            self.rig.launcher.rates.lock().unwrap().clone()
        }

        /// Starts the track's helper and waits for it, as a prepare does.
        fn ready_helper(&self) -> Arc<FakeSession> {
            let requests = self.requests();
            self.audio.plugin_plans(&self.owner.document_id, &requests);
            self.settle();
            self.rig
                .launcher
                .last_session
                .lock()
                .unwrap()
                .clone()
                .unwrap()
        }

        /// Records the mixes the runtime builds instead of installing them in the audio service.
        fn record_mixes(&self) {
            *self.audio.test_mixes.lock().unwrap() = Some(Vec::new());
        }

        fn mixes(&self) -> Vec<TestMix> {
            self.audio
                .test_mixes
                .lock()
                .unwrap()
                .as_mut()
                .map(std::mem::take)
                .unwrap_or_default()
        }

        /// Gives the track a plug-in state whose component is `component`, through the real edit path, as an undo or a
        /// redo does, and returns the settings that now hold it.
        fn edit_state(&self, component: &[u8]) -> DocumentSettings {
            let mut ws = self.workspace.lock().unwrap();
            let bytes = encode_state(component, b"d").unwrap();
            let asset =
                StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
            let id = asset.id().unwrap();
            let staged = ws.stage_asset(&self.owner.document_id, asset).unwrap();
            let rev = DocumentRevision {
                document_id: self.owner.document_id.clone(),
                revision: ws.document(&self.owner.document_id).unwrap().revision,
            };
            let sound = TrackSound {
                plugin: Some(test_slot(&self.rig.class_id, &id)),
                ..TrackSound::default()
            };
            ws.apply_edit(
                &rev,
                EditCommand::SetTrackSound {
                    track_id: "base/0".into(),
                    sound: sound.clone(),
                },
                Some(&staged.token),
            )
            .unwrap();
            drop(ws);
            self.rig
                .service
                .grant_consent(&self.owner.document_id, &[(self.rig.class_id.clone(), id)])
                .unwrap();
            let mut settings = DocumentSettings::default();
            settings.sounds.insert("base/0".into(), sound);
            settings
        }

        /// Closes the document, as the app does: the workspace shuts its plug-ins down.
        fn close_document(&self) {
            let mut ws = self.workspace.lock().unwrap();
            let revision = ws.document(&self.owner.document_id).unwrap().revision;
            ws.close_documents(&[crate::workspace::CloseDocument {
                document_id: self.owner.document_id.clone(),
                revision,
                discard: true,
            }])
            .unwrap();
            assert_ne!(ws.active_owner(), &self.owner);
        }

        fn requests(&self) -> Vec<crate::plugins::service::SlotRequest> {
            let ws = self.workspace.lock().unwrap();
            let slot = self.sound.plugin.clone().unwrap();
            vec![crate::plugins::service::SlotRequest {
                track_id: "base/0".into(),
                state: ws
                    .asset_bytes(&self.owner.document_id, &slot.state)
                    .unwrap()
                    .into(),
                slot,
            }]
        }
    }

    /// A document whose track `base/0` has a plug-in slot, and a mix remembered as built at `rate` for `frames`.
    fn tick_rig(rate: Option<u32>, frames: u32) -> Tick {
        let rig = test_rig();
        let mut ws = DocumentWorkspace::new().unwrap();
        ws.set_plugins(rig.service.clone());
        let owner = ws.active_owner().clone();
        let bytes = encode_state(b"c", b"d").unwrap();
        let asset = StoredAsset::from_bytes(STATE_FILENAME.into(), STATE_MEDIA_TYPE.into(), &bytes);
        let id = asset.id().unwrap();
        let staged = ws.stage_asset(&owner.document_id, asset).unwrap();
        let rev = DocumentRevision {
            document_id: owner.document_id.clone(),
            revision: ws.document(&owner.document_id).unwrap().revision,
        };
        let sound = TrackSound {
            plugin: Some(test_slot(&rig.class_id, &id)),
            ..TrackSound::default()
        };
        ws.apply_edit(
            &rev,
            EditCommand::SetTrackSound {
                track_id: "base/0".into(),
                sound: sound.clone(),
            },
            Some(&staged.token),
        )
        .unwrap();
        rig.service
            .grant_consent(&owner.document_id, &[(rig.class_id.clone(), id)])
            .unwrap();
        let audio =
            NativeAudio::new(PathBuf::new(), Arc::new(|_| {})).with_plugins(rig.service.clone());
        *audio.test_device.lock().unwrap() = Some((rate, frames));
        let mut settings = DocumentSettings::default();
        settings.sounds.insert("base/0".into(), sound.clone());
        audio.remember_mix(&owner, settings, 1, frames, rate);
        Tick {
            audio,
            workspace: Mutex::new(ws),
            rig,
            owner,
            sound,
        }
    }

    #[test]
    fn nothing_changed_builds_nothing() {
        let tick = tick_rig(Some(48_000), 512);
        assert!(!tick.audio.plugin_tick(&tick.workspace));
        assert!(tick.launches().is_empty());
    }

    #[test]
    fn a_larger_device_callback_builds_the_mix_again_once() {
        let tick = tick_rig(Some(48_000), 512);
        tick.device(Some(48_000), 1024);
        assert!(tick.audio.plugin_tick(&tick.workspace));
        assert_eq!(tick.launches(), vec![48_000]);
        tick.settle();
        // The mix could not be built (nothing is prepared here), and the tick does not try again until something
        // changes once more.
        assert!(!tick.audio.plugin_tick(&tick.workspace));
    }

    #[test]
    fn a_smaller_device_callback_builds_nothing() {
        let tick = tick_rig(Some(48_000), 512);
        tick.device(Some(48_000), 256);
        assert!(!tick.audio.plugin_tick(&tick.workspace));
    }

    #[test]
    fn a_new_device_rate_starts_the_plug_ins_at_it() {
        let tick = tick_rig(Some(48_000), 512);
        tick.device(Some(44_100), 512);
        assert!(tick.audio.plugin_tick(&tick.workspace));
        assert_eq!(tick.launches(), vec![44_100]);
    }

    #[test]
    fn the_first_open_stream_starts_the_plug_ins() {
        let tick = tick_rig(None, 512);
        tick.device(Some(44_100), 512);
        assert!(tick.audio.plugin_tick(&tick.workspace));
        assert_eq!(tick.launches(), vec![44_100]);
    }

    #[test]
    fn a_plug_in_service_request_builds_the_mix_again() {
        let tick = tick_rig(Some(48_000), 512);
        tick.rig.service.request_reprepare(&tick.owner.document_id);
        assert!(tick.audio.plugin_tick(&tick.workspace));
        tick.settle();
        assert!(!tick.audio.plugin_tick(&tick.workspace));
    }

    #[test]
    fn a_mix_without_plug_ins_is_left_alone() {
        let tick = tick_rig(Some(48_000), 512);
        tick.audio.remember_mix(
            &tick.owner,
            DocumentSettings::default(),
            1,
            512,
            Some(48_000),
        );
        tick.device(Some(44_100), 4096);
        assert!(!tick.audio.plugin_tick(&tick.workspace));
    }

    #[test]
    fn an_insert_the_renderer_would_refuse_is_reported_before_the_mix_is_built() {
        let tick = tick_rig(Some(48_000), 512);
        let requests = tick.requests();
        tick.audio.plugin_plans(&tick.owner.document_id, &requests);
        assert_eq!(
            wait_for_slot(&tick.rig.service, &tick.owner.document_id, "base/0"),
            PluginStatus::Ready
        );
        let session = tick
            .rig
            .launcher
            .last_session
            .lock()
            .unwrap()
            .clone()
            .unwrap();
        // Over a tenth of a second at 48 kHz.
        session.latency.store(4_801, Ordering::SeqCst);
        let (plans, _, _) = tick.audio.plugin_plans(&tick.owner.document_id, &requests);
        assert_eq!(
            plans[0].1.as_ref().err(),
            Some(&PluginStatus::TooMuchLatency)
        );
        assert_eq!(
            tick.rig.service.statuses(&tick.owner.document_id)[0].status,
            PluginStatus::TooMuchLatency
        );
    }

    #[test]
    fn an_insert_the_audio_service_refused_reaches_the_slot_status() {
        use crate::audio::plugin_insert::InsertError;
        let tick = tick_rig(Some(48_000), 512);
        let document_id = tick.owner.document_id.clone();
        tick.ready_helper();
        assert_eq!(
            wait_for_slot(&tick.rig.service, &document_id, "base/0"),
            PluginStatus::Ready
        );
        // The device changed between the runtime's check and the build, and the build refused the insert.
        tick.audio.report_insert_refusals(
            &document_id,
            vec![("base/0".to_string(), InsertError::TooMuchLatency)],
        );
        assert_eq!(
            tick.rig.service.statuses(&document_id)[0].status,
            PluginStatus::TooMuchLatency
        );
        tick.audio.report_insert_refusals(
            &document_id,
            vec![("base/0".to_string(), InsertError::PipelineTooLong)],
        );
        assert_eq!(
            tick.rig.service.statuses(&document_id)[0].status,
            PluginStatus::Underrun
        );
        // A helper at another rate is not the plug-in's fault: the mix is built again at the device's rate.
        tick.rig.service.take_reprepare(&document_id);
        tick.audio.report_insert_refusals(
            &document_id,
            vec![("base/0".to_string(), InsertError::RateMismatch)],
        );
        assert!(tick.rig.service.take_reprepare(&document_id));
    }

    /// A plan of the one track `base/0`, for building a mix by hand.
    fn one_track_plan() -> PlaybackPlan {
        serde_json::from_value(serde_json::json!({
            "generation": 1,
            "ppq": 960,
            "durationTick": 3840,
            "durationMs": 2000,
            "tracks": [{"id": "base/0", "program": 0, "percussion": false}],
            "tempos": [{"tick": 0, "bpm": 120}],
            "occurrences": [
                {"bar": 0, "occurrence": 0, "meterNumerator": 4, "meterDenominator": 4, "startTick": 0, "endTick": 3840, "startMs": 0, "endMs": 2000}
            ],
            "notes": [],
            "midi": []
        }))
        .unwrap()
    }

    #[test]
    fn a_larger_device_callback_installs_a_mix_with_the_longer_pipeline() {
        use tabplayer_plugin_protocol::limits::pipeline_frames;
        let tick = tick_rig(Some(48_000), 512);
        tick.record_mixes();
        let session = tick.ready_helper();
        session.latency.store(64, Ordering::SeqCst);
        tick.device(Some(48_000), 1024);
        assert!(tick.audio.plugin_tick(&tick.workspace));
        let mixes = tick.mixes();
        assert_eq!(mixes.len(), 1, "one mix is installed");
        let mix = &mixes[0];
        assert_eq!(mix.frames, 1024);
        assert!(mix.plans[0].1.is_ok(), "with the ready helper's insert");
        // The mix the audio service would build from it delays by the plug-in's latency and the longer pipeline.
        let built = crate::audio::renderer::PreparedMix::prepare_with_plugins(
            &mix.settings,
            &one_track_plan(),
            48_000,
            &mix.plans,
            mix.frames as usize,
        )
        .unwrap();
        assert!(pipeline_frames(1024) > pipeline_frames(512));
        assert_eq!(built.plugin_delay_frames(), 64 + pipeline_frames(1024));
        // Built: the tick has nothing more to do.
        assert!(!tick.audio.plugin_tick(&tick.workspace));
    }

    #[test]
    fn an_undo_during_a_reprepare_is_not_undone_by_it() {
        let tick = tick_rig(Some(48_000), 512);
        tick.record_mixes();
        let session = tick.ready_helper();
        let undo = tick.edit_state(b"undo");
        tick.rig.service.request_reprepare(&tick.owner.document_id);
        let (reached, in_tick) = std::sync::mpsc::channel();
        *tick.audio.tick_pause.lock().unwrap() = Some(Box::new(move || {
            reached.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        }));
        std::thread::scope(|scope| {
            let ticking = scope.spawn(|| tick.audio.plugin_tick(&tick.workspace));
            in_tick.recv().unwrap();
            // The undo's prepare comes while the tick is between reading what to build and asking for the plug-ins.
            tick.audio
                .set_mix(&tick.workspace, &tick.owner, undo.clone(), 1)
                .unwrap();
            ticking.join().unwrap();
        });
        assert_eq!(
            session.current_state.lock().unwrap().component,
            b"undo",
            "the helper holds the document's state"
        );
        let memo = tick.audio.plugin_memo.lock().unwrap().clone().unwrap();
        assert_eq!(memo.settings, undo, "and the mix is the one built for it");
    }

    #[test]
    fn a_closed_document_gets_no_helpers_from_a_tick() {
        let tick = tick_rig(Some(48_000), 512);
        tick.record_mixes();
        tick.close_document();
        tick.device(Some(44_100), 1024);
        tick.rig.service.request_reprepare(&tick.owner.document_id);
        assert!(!tick.audio.plugin_tick(&tick.workspace));
        assert!(tick.launches().is_empty());
        assert!(tick.mixes().is_empty());
    }

    #[test]
    fn opening_another_document_shuts_down_the_helpers_of_the_one_left() {
        let tick = tick_rig(Some(48_000), 512);
        let session = tick.ready_helper();
        assert!(!session.shutdown_called.load(Ordering::SeqCst));
        {
            let mut ws = tick.workspace.lock().unwrap();
            let fork = ws.stage_fork(crate::project::Project::blank()).unwrap();
            ws.add_document(&fork.token).unwrap();
            assert_ne!(ws.active_owner().document_id, tick.owner.document_id);
        }
        assert!(
            session.shutdown_called.load(Ordering::SeqCst),
            "the helper of the document left behind is shut down, as an activation does"
        );
        assert!(
            tick.rig
                .service
                .statuses(&tick.owner.document_id)
                .is_empty()
        );
    }

    #[test]
    fn a_document_switched_away_during_a_tick_has_the_helpers_it_started_shut_down() {
        let tick = tick_rig(Some(48_000), 512);
        tick.record_mixes();
        // A second document, open but not active.
        let other = {
            let mut ws = tick.workspace.lock().unwrap();
            let fork = ws.stage_fork(crate::project::Project::blank()).unwrap();
            ws.add_document(&fork.token).unwrap();
            let other = ws.active_owner().document_id.clone();
            ws.activate_document(&tick.owner.document_id).unwrap();
            other
        };
        // Activated again: the mix is remembered for the new activation.
        let owner = tick.workspace.lock().unwrap().active_owner().clone();
        let settings = tick
            .audio
            .plugin_memo
            .lock()
            .unwrap()
            .clone()
            .unwrap()
            .settings;
        tick.audio
            .remember_mix(&owner, settings, 1, 512, Some(48_000));
        tick.ready_helper();
        let (reached, in_tick) = std::sync::mpsc::channel();
        *tick.audio.tick_pause.lock().unwrap() = Some(Box::new(move || {
            reached.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        }));
        // A new device rate: the tick replaces the helper with one at that rate.
        tick.device(Some(44_100), 512);
        std::thread::scope(|scope| {
            let ticking = scope.spawn(|| tick.audio.plugin_tick(&tick.workspace));
            in_tick.recv().unwrap();
            tick.workspace
                .lock()
                .unwrap()
                .activate_document(&other)
                .unwrap();
            ticking.join().unwrap();
        });
        let start = Instant::now();
        loop {
            let sessions = tick.rig.launcher.sessions.lock().unwrap().clone();
            let started = sessions.iter().find(|session| session.rate == 44_100);
            if started.is_some_and(|session| session.shutdown_called.load(Ordering::SeqCst)) {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "the helper the tick started for the document switched away from is shut down"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(tick.rig.service.statuses(&owner.document_id).is_empty());
    }

    #[test]
    fn a_document_closed_during_a_tick_keeps_no_plug_in_state() {
        let tick = tick_rig(Some(48_000), 512);
        tick.record_mixes();
        tick.ready_helper();
        let (reached, in_tick) = std::sync::mpsc::channel();
        *tick.audio.tick_pause.lock().unwrap() = Some(Box::new(move || {
            reached.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        }));
        // A new device rate: the tick replaces the helper with one at that rate.
        tick.device(Some(44_100), 512);
        std::thread::scope(|scope| {
            let ticking = scope.spawn(|| tick.audio.plugin_tick(&tick.workspace));
            in_tick.recv().unwrap();
            tick.close_document();
            ticking.join().unwrap();
        });
        // Its states went with it, so nothing could start; and the statuses the tick's request recorded are gone.
        std::thread::sleep(Duration::from_millis(100));
        let sessions = tick.rig.launcher.sessions.lock().unwrap().clone();
        assert!(
            sessions
                .iter()
                .all(|session| session.shutdown_called.load(Ordering::SeqCst))
        );
        assert!(
            tick.rig
                .service
                .statuses(&tick.owner.document_id)
                .is_empty()
        );
    }

    #[test]
    fn a_request_made_during_a_workspace_freeze_waits_for_it_to_end() {
        let tick = tick_rig(Some(48_000), 512);
        tick.record_mixes();
        tick.rig.service.request_reprepare(&tick.owner.document_id);
        tick.workspace.lock().unwrap().freeze().unwrap();
        assert!(!tick.audio.plugin_tick(&tick.workspace));
        tick.workspace.lock().unwrap().unfreeze();
        assert!(
            tick.audio.plugin_tick(&tick.workspace),
            "the request is still there once the freeze ends"
        );
    }

    #[test]
    fn a_stopped_tick_builds_nothing() {
        let tick = tick_rig(Some(48_000), 512);
        tick.audio.stop_plugin_tick();
        tick.rig.service.request_reprepare(&tick.owner.document_id);
        tick.device(Some(44_100), 1024);
        assert!(!tick.audio.plugin_tick(&tick.workspace));
        assert!(tick.launches().is_empty());
    }
}
