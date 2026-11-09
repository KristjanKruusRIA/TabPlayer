// Vendored from SoundCraft (github.com/storytold/soundcraft) crates/vst3-host at b6f9f15, used under its MIT licence.
// Copyright (c) 2026 ArtCraft Team and the SoundCraft contributors. The licence text is in NOTICE.md in this folder.
// Changed for TabPlayer (THE-71): the Windows extract only. Changes are marked "TabPlayer:".

//! The FFI boundary: the only module of this crate allowed to use `unsafe`.
//!
//! It loads VST3 binaries (`libloading`), runs the platform module entry, calls the COM
//! interfaces of the factory, component, audio processor and edit controller (`vst3` raw
//! bindings), and implements the host-side COM objects (host context, parameter changes, event
//! lists, a memory stream). Everything it exposes to the rest of the crate is a safe API.
//!
//! Soundness rests on the VST3 contract (the plugin honours the COM vtable signatures and the
//! documented pointer lifetimes). A plugin that violates it can still crash the process: hosting
//! in-process can't prevent that. What this module guarantees is that *SoundCraft* never hands
//! the plugin dangling or mis-sized pointers and never reads plugin strings beyond their bounds.

// VST3 enum constants are `c_int` on Windows and `c_uint` elsewhere, so casts that are no-ops on
// one platform are needed on another.
#![allow(clippy::unnecessary_cast)]

use std::ffi::{c_char, c_int, c_void};
use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, TryLockError, mpsc};
use std::time::Duration;
use vst3::Steinberg::Vst::{self as sv};
use vst3::Steinberg::Vst::{
    IAudioProcessorTrait, IComponentHandlerTrait, IComponentTrait, IConnectionPointTrait,
    IEditControllerTrait, IEventListTrait, IHostApplicationTrait, IParamValueQueueTrait,
    IParameterChangesTrait,
};
use vst3::Steinberg::{self as sb};
use vst3::Steinberg::{
    FUnknown, IBStreamTrait, IPlugFrameTrait, IPlugViewTrait, IPluginBaseTrait,
    IPluginFactory2Trait, IPluginFactoryTrait,
};
use vst3::{Class, ComPtr, ComWrapper, Interface};

mod editor;
mod host;
mod instance;
mod module;
mod process;
mod queue;
mod scan;
mod window;

pub(crate) use editor::{EditorLink, StateReadError};
pub(crate) use instance::{AudioPart, Instance, Layout};
pub(crate) use module::{Bundle, exit_modules};
pub(crate) use window::{set_main_thread, window_pid};
// TabPlayer: the transport a block carries into `ProcessContext` is the crate's own sanitized `Transport` (SoundCraft's was
// `soundcraft_dsp::Transport`, with the same eight fields).
pub(crate) use crate::core::Transport;

/// Most classes one factory may report (hostile-input cap). The probe then keeps at most 64 audio effects.
const MAX_CLASSES: i32 = 1024;
/// Most parameters read from one controller.
pub(crate) const MAX_PARAMS: i32 = 4096;
/// Most audio buses per direction we provide buffers for. Multi-out instruments declare dozens
/// of (mostly inactive) aux buses, e.g. 32 for a drum sampler; every one still gets buffers.
const MAX_BUSES: i32 = 64;
/// Most channels per audio bus.
const MAX_BUS_CHANNELS: u32 = 64;
/// Capacity of the per-block event lists (preallocated: `process` never allocates).
pub(crate) const EVENT_CAP: usize = 1024;
/// Most parameter queues per block (preallocated).
pub(crate) const PARAM_QUEUE_CAP: usize = 1024;
/// Points one parameter queue holds per block (preallocated). Edits past it replace the last point.
pub(crate) const QUEUE_POINTS: usize = 16;
/// TabPlayer: the most one component or controller state may hold, which is the protocol's cap on a whole container
/// (preflight ruling P10). SoundCraft allowed 64 MiB. A state past it is refused with `StateTooLarge`.
const MAX_STATE_BYTES: usize = tabplayer_plugin_protocol::MAX_STATE_BYTES;
/// Capacity of the lock-free queue that carries editor edits to the processor.
pub(crate) const EDIT_QUEUE_CAP: usize = 1024;
/// Most edits the audio thread takes from that queue in one block.
pub(crate) const EDITS_PER_BLOCK: usize = 256;

// ---- strings -------------------------------------------------------------------------------

/// Reads a fixed-size `char8[N]` buffer, stopping at the first NUL or the end of the array.
fn read_c8(buf: &[c_char]) -> String {
    let bytes: Vec<u8> = buf
        .iter()
        .take_while(|c| **c != 0)
        .map(|c| *c as u8)
        .collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}

/// Writes `s` into a UTF-16 buffer, truncated and always NUL-terminated.
fn write_c16(s: &str, dst: &mut [u16]) {
    let Some(room) = dst.len().checked_sub(1) else {
        return;
    };
    let mut n = 0;
    for (d, u) in dst.iter_mut().zip(s.encode_utf16().take(room)) {
        *d = u;
        n += 1;
    }
    if let Some(z) = dst.get_mut(n) {
        *z = 0;
    }
}

fn ok(r: sb::tresult) -> bool {
    r == sb::kResultOk
}

/// TabPlayer: SoundCraft's error type, with its five variants and a hand-written `Display` (it used `thiserror`).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Vst3Error {
    Load(String, String),
    Instantiate(String, String),
    Process(String),
}

impl std::fmt::Display for Vst3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Vst3Error::Load(a, b) => write!(f, "cannot load VST3 plugin {a}: {b}"),
            Vst3Error::Instantiate(a, b) => write!(f, "cannot create VST3 plugin `{a}`: {b}"),
            Vst3Error::Process(a) => write!(f, "VST3 processing: {a}"),
        }
    }
}

/// The `RestartFlags` bits of `IComponentHandler::restartComponent` that the helper acts on or names.
pub(crate) struct RestartFlags;

#[allow(dead_code)]
impl RestartFlags {
    pub const RELOAD_COMPONENT: u32 = sv::RestartFlags_::kReloadComponent as u32;
    pub const IO_CHANGED: u32 = sv::RestartFlags_::kIoChanged as u32;
    pub const PARAM_VALUES_CHANGED: u32 = sv::RestartFlags_::kParamValuesChanged as u32;
    pub const LATENCY_CHANGED: u32 = sv::RestartFlags_::kLatencyChanged as u32;
    pub const PARAM_TITLES_CHANGED: u32 = sv::RestartFlags_::kParamTitlesChanged as u32;
    pub const MIDI_CC_ASSIGNMENT_CHANGED: u32 = sv::RestartFlags_::kMidiCCAssignmentChanged as u32;
    pub const NOTE_EXPRESSION_CHANGED: u32 = sv::RestartFlags_::kNoteExpressionChanged as u32;
    pub const IO_TITLES_CHANGED: u32 = sv::RestartFlags_::kIoTitlesChanged as u32;
    pub const PREFETCHABLE_SUPPORT_CHANGED: u32 =
        sv::RestartFlags_::kPrefetchableSupportChanged as u32;
    pub const ROUTING_INFO_CHANGED: u32 = sv::RestartFlags_::kRoutingInfoChanged as u32;
}
