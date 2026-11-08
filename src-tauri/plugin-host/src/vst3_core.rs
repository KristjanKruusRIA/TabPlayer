//! The real hosting core: one VST3 plug-in, through the vendored SoundCraft FFI in `vst3/`.
//!
//! Threads: everything here except [`Vst3Processor`] runs on the main thread, which owns the controller and the editor
//! (VST3's own model). The processor is moved to the audio thread. They share only the host context's atomics and its
//! lock-free edit queue.
use crate::{
    audio::PauseGate,
    core::{BlockProcessor, CoreError, CoreEvent, PluginCore, Transport, sanitize},
    editor,
    probe::{self, RawClassInfo},
    vst3::{AudioPart, Bundle, EditorLink, Instance, Layout, RestartFlags, StateReadError},
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tabplayer_plugin_protocol::{
    control::{ClassInfo, ErrorCode, Mode, Rect},
    limits::BLOCK_FRAMES,
    ring::BlockMeta,
};

/// How long a reconfigure waits for the audio thread to park.
const PAUSE_TIMEOUT: Duration = Duration::from_secs(2);

/// What a `restartComponent` call asks the helper to do (preflight ruling P15). Parameter, title, MIDI controller and
/// note-expression flags stay with the controller and change nothing here: turning a knob must not make the audio dip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartPlan {
    /// `kReloadComponent` or `kIoChanged`: the plug-in is deactivated and set up again, with the audio thread parked.
    pub reconfigure: bool,
    /// `kIoChanged` (and `kLatencyChanged`) always tell the app to re-prepare; `kReloadComponent` only if the latency moved.
    pub report_always: bool,
    /// `kLatencyChanged`: read the latency again, and report it if it differs.
    pub reread_latency: bool,
}

pub fn restart_plan(flags: u32) -> RestartPlan {
    let has = |flag: u32| flags & flag != 0;
    RestartPlan {
        reconfigure: has(RestartFlags::RELOAD_COMPONENT) || has(RestartFlags::IO_CHANGED),
        report_always: has(RestartFlags::IO_CHANGED),
        reread_latency: has(RestartFlags::LATENCY_CHANGED),
    }
}

/// The audio-layout rule: the main input and output are both stereo, or both mono (then the helper downmixes and
/// duplicates). Returns whether the plug-in is mono.
fn main_layout(layout: &Layout) -> Result<bool, CoreError> {
    match (layout.inputs.first(), layout.outputs.first()) {
        (Some(2), Some(2)) => Ok(false),
        (Some(1), Some(1)) => Ok(true),
        (None, _) | (_, None) => Err(CoreError::new(
            ErrorCode::UnsupportedLayout,
            "This plug-in is not an effect: it has no audio input or no audio output.",
        )),
        _ => Err(CoreError::new(
            ErrorCode::UnsupportedLayout,
            "This plug-in does not take a stereo or mono signal.",
        )),
    }
}

pub struct Vst3Core {
    class: ClassInfo,
    instance: Instance,
    editor: Arc<EditorLink>,
    sample_rate: u32,
    mono: bool,
    layout: Layout,
    /// The ids of the plug-in's own parameters. VST3 parameter ids are arbitrary 32-bit numbers, so the app's ids are
    /// checked against this list.
    params: HashSet<u32>,
    /// The latency the app was last told.
    reported_latency: u32,
    editor_open: bool,
    app_pid: u32,
}

fn unreadable(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(ErrorCode::Unreadable, error.to_string())
}

fn open_bundle(bundle: &Path) -> Result<Arc<Bundle>, CoreError> {
    if !bundle.exists() {
        return Err(CoreError::new(
            ErrorCode::NotFound,
            "The plug-in file is missing.",
        ));
    }
    Bundle::load(bundle).map_err(unreadable)
}

impl PluginCore for Vst3Core {
    fn probe(bundle: &Path) -> Result<Vec<ClassInfo>, CoreError> {
        let bundle = open_bundle(bundle)?;
        let raw: Vec<RawClassInfo> = bundle
            .classes()
            .into_iter()
            .map(|c| RawClassInfo {
                cid: c.cid,
                category: c.category,
                name: c.name,
                vendor: c.vendor,
                version: c.version,
                sub_categories: c.sub_categories,
            })
            .collect();
        Ok(probe::effect_classes(&raw))
    }

    fn load(bundle: &Path, class_id: &str, rate: u32, mode: Mode) -> Result<Vst3Core, CoreError> {
        let cid = probe::class_id_bytes(class_id)
            .ok_or_else(|| CoreError::new(ErrorCode::BadRequest, "Invalid plug-in class ID."))?;
        let module = open_bundle(bundle)?;
        let class = module
            .classes()
            .into_iter()
            .find(|c| c.cid == cid)
            .map(|c| RawClassInfo {
                cid: c.cid,
                category: c.category,
                name: c.name,
                vendor: c.vendor,
                version: c.version,
                sub_categories: c.sub_categories,
            })
            .filter(probe::is_audio_effect)
            .ok_or_else(|| {
                CoreError::new(
                    ErrorCode::NotFound,
                    "The plug-in file has no such audio effect.",
                )
            })?;
        let mut instance = module
            .instantiate(&cid, crate::runtime::wake_main)
            .map_err(unreadable)?;
        instance.set_offline(mode == Mode::Offline);
        let layout = instance
            .configure(f64::from(rate), BLOCK_FRAMES, false)
            .map_err(unreadable)?;
        let mono = main_layout(&layout)?;
        let editor = instance.state_link();
        let params = instance.params().into_iter().map(|p| p.id).collect();
        let reported_latency = instance.latency();
        Ok(Vst3Core {
            class: probe::clean_class(&class),
            instance,
            editor,
            sample_rate: rate,
            mono,
            layout,
            params,
            reported_latency,
            editor_open: false,
            app_pid: 0,
        })
    }

    fn set_app_pid(&mut self, pid: u32) {
        self.app_pid = pid;
    }

    fn class(&self) -> &ClassInfo {
        &self.class
    }

    fn mono(&self) -> bool {
        self.mono
    }

    fn latency(&self) -> u32 {
        self.reported_latency
    }

    fn set_state(&mut self, component: &[u8], controller: &[u8]) -> Result<(), CoreError> {
        if !self.instance.load_state(component, controller) {
            return Err(CoreError::new(
                ErrorCode::RejectedState,
                "The plug-in refused its state.",
            ));
        }
        // The state may have changed the latency; the plug-in then announces it through `restartComponent`, which
        // `poll` handles. Reading it here keeps `Loaded` honest when the state is part of the load.
        self.reported_latency = self.instance.latency();
        Ok(())
    }

    fn state(&mut self) -> Result<(Vec<u8>, Vec<u8>), CoreError> {
        self.editor.save_state().map_err(|error| match error {
            StateReadError::TooLarge => CoreError::new(
                ErrorCode::StateTooLarge,
                "The plug-in's state is too large to keep.",
            ),
            StateReadError::Failed => {
                CoreError::new(ErrorCode::Internal, "The plug-in could not save its state.")
            }
        })
    }

    fn set_parameter(&mut self, id: u32, value: f64) -> Result<(), CoreError> {
        if !self.params.contains(&id) {
            return Err(CoreError::new(
                ErrorCode::BadRequest,
                "The plug-in has no such parameter.",
            ));
        }
        let value = value.clamp(0.0, 1.0);
        // The processor gets the value at its next block; the controller shows it in the editor.
        if !self.instance.host().edits.push(id, value) {
            return Err(CoreError::new(
                ErrorCode::BadRequest,
                "The plug-in is not keeping up with parameter changes.",
            ));
        }
        self.instance.set_normalized(id, value);
        Ok(())
    }

    fn processor(&mut self) -> Result<Box<dyn BlockProcessor + Send>, CoreError> {
        let part = self
            .instance
            .audio_part(
                &self.layout,
                f64::from(self.sample_rate),
                BLOCK_FRAMES,
                self.mono,
            )
            .map_err(unreadable)?;
        Ok(Box::new(Vst3Processor { part }))
    }

    fn open_editor(&mut self, title: &str, near: Option<Rect>) -> Result<u64, CoreError> {
        let fail = |detail: &str| CoreError::new(ErrorCode::EditorFailed, detail);
        let link = self
            .instance
            .editor()
            .ok_or_else(|| fail("This plug-in has no editor."))?;
        let near = near.map(|r| (r.x, r.y, r.width, r.height));
        let opened = link.open(title, near).map_err(|e| fail(&e))?;
        // The window must be this process's own before its handle goes to the app (preflight ruling P29).
        if !editor::is_own_window(opened.hwnd) {
            link.close();
            return Err(fail("The editor window does not belong to the helper."));
        }
        self.editor_open = true;
        Ok(opened.hwnd as u64)
    }

    fn close_editor(&mut self) {
        // Spike 4: the helper lets the app take the foreground back before the window goes.
        editor::allow_app_foreground(self.app_pid);
        self.editor.close();
        self.editor_open = false;
    }

    fn poll(&mut self, gate: &PauseGate) -> Vec<CoreEvent> {
        let mut events = Vec::new();
        let flags = self.instance.host().take_restart_flags();
        if flags != 0 {
            self.restart(flags, gate, &mut events);
        }
        if self.instance.host().take_dirty() {
            events.push(CoreEvent::StateDirty);
        }
        if self.editor_open && self.editor.closed_by_user() {
            editor::allow_app_foreground(self.app_pid);
            self.editor.close();
            self.editor_open = false;
            events.push(CoreEvent::EditorClosed);
        }
        events
    }
}

impl Vst3Core {
    fn restart(&mut self, flags: u32, gate: &PauseGate, events: &mut Vec<CoreEvent>) {
        let plan = restart_plan(flags);
        if plan.reconfigure {
            if !gate.pause(PAUSE_TIMEOUT) {
                // The audio thread is stuck inside the plug-in. The supervisor's heartbeat rule deals with that.
                return;
            }
            let result =
                self.instance
                    .configure(f64::from(self.sample_rate), BLOCK_FRAMES, self.mono);
            match result {
                Ok(layout) if layout == self.layout => {}
                Ok(_) => {
                    events.push(CoreEvent::Fatal(CoreError::new(
                        ErrorCode::UnsupportedLayout,
                        "The plug-in changed its audio layout.",
                    )));
                    return;
                }
                Err(error) => {
                    events.push(CoreEvent::Fatal(unreadable(error)));
                    return;
                }
            }
            gate.resume();
        }
        if plan.reconfigure || plan.reread_latency {
            let latency = self.instance.latency();
            if plan.report_always || latency != self.reported_latency {
                self.reported_latency = latency;
                events.push(CoreEvent::LatencyChanged(latency));
            }
        }
    }
}

/// The processor side, on the audio thread.
struct Vst3Processor {
    part: AudioPart,
}

impl BlockProcessor for Vst3Processor {
    fn reset(&mut self) {
        self.part.reset();
    }

    fn process(&mut self, input: &[[f32; 2]], output: &mut [[f32; 2]], ctx: &BlockMeta) {
        let transport: Transport = sanitize(ctx);
        // A failure leaves silence in `output`; the app hears the fallback when the block is late or non-finite.
        let _ = self.part.process(input, output, &transport);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn param_restart_flags_do_not_reprepare() {
        use RestartFlags as F;
        for flag in [
            F::PARAM_VALUES_CHANGED,
            F::PARAM_TITLES_CHANGED,
            F::MIDI_CC_ASSIGNMENT_CHANGED,
            F::NOTE_EXPRESSION_CHANGED,
            F::IO_TITLES_CHANGED,
            F::PREFETCHABLE_SUPPORT_CHANGED,
            F::ROUTING_INFO_CHANGED,
            F::PARAM_VALUES_CHANGED | F::PARAM_TITLES_CHANGED | F::MIDI_CC_ASSIGNMENT_CHANGED,
            0,
        ] {
            let plan = restart_plan(flag);
            assert!(
                !plan.reconfigure && !plan.reread_latency && !plan.report_always,
                "flag {flag:#x}"
            );
        }
    }

    #[test]
    fn latency_io_and_reload_flags_have_their_own_actions() {
        use RestartFlags as F;
        let latency = restart_plan(F::LATENCY_CHANGED);
        assert!(latency.reread_latency && !latency.reconfigure && !latency.report_always);
        let io = restart_plan(F::IO_CHANGED);
        assert!(io.reconfigure && io.report_always);
        let reload = restart_plan(F::RELOAD_COMPONENT);
        assert!(reload.reconfigure && !reload.report_always && !reload.reread_latency);
        // A param change riding along with a reload does not matter.
        assert_eq!(
            restart_plan(F::RELOAD_COMPONENT | F::PARAM_VALUES_CHANGED),
            reload
        );
    }

    #[test]
    fn only_stereo_and_mono_effects_are_accepted() {
        let layout = |inputs: &[u32], outputs: &[u32]| Layout {
            inputs: inputs.to_vec(),
            outputs: outputs.to_vec(),
            event_input: false,
        };
        assert_eq!(main_layout(&layout(&[2], &[2])).unwrap(), false);
        assert_eq!(
            main_layout(&layout(&[2, 2], &[2])).unwrap(),
            false,
            "a sidechain is fine"
        );
        assert_eq!(main_layout(&layout(&[1], &[1])).unwrap(), true);
        for bad in [
            layout(&[], &[2]),
            layout(&[2], &[]),
            layout(&[1], &[2]),
            layout(&[6], &[6]),
        ] {
            assert_eq!(
                main_layout(&bad).unwrap_err().code,
                ErrorCode::UnsupportedLayout
            );
        }
    }
}
