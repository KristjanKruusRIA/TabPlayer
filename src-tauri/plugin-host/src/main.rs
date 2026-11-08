//! The VST3 plug-in host helper (THE-71, Task 8): one plug-in per process, run out of process for the app.
//!
//! The protocol: the first frame on stdin is `Probe` (answered with `Probed`, then the helper exits) or `Load`
//! (answered with `Loaded`, after which the helper serves requests and runs the audio ring). Stdin closing means exit 0.
//! The wire format, the ring and the limits are the `tabplayer-plugin-protocol` crate's.
//!
//! On Windows the plug-in is hosted through the vendored SoundCraft FFI in `vst3/`. Elsewhere the binary is a stub that
//! answers every request with `UnsupportedPlatform`.
// Off Windows only the stub runs; the session, audio loop and probe rules are still built (and unit tested) there.
#![cfg_attr(not(windows), allow(dead_code))]

mod audio;
mod core;
mod probe;
mod session;
mod stub;

#[cfg(windows)]
mod editor;
#[cfg(windows)]
mod runtime;
#[cfg(windows)]
mod vst3;
#[cfg(windows)]
mod vst3_core;
#[cfg(windows)]
mod winio;

#[cfg(windows)]
fn main() {
    runtime::exit_with(runtime::main());
}

#[cfg(not(windows))]
fn main() {
    std::process::exit(stub::main());
}
