//! The helper on a platform without a plug-in host: it answers every request with `Error { UnsupportedPlatform }`.
//!
//! The binary builds on Windows, macOS and Linux so the workspace does; only Windows hosts plug-ins (Spike 1 chose the
//! Rust core, and its window code is Windows only). The app learns of it from the first reply and never offers plug-ins.
#![cfg_attr(windows, allow(dead_code))]
use std::io::{Read, Write};
use tabplayer_plugin_protocol::control::{
    ErrorCode, FrameError, HelperMessage, HostMessage, read_frame, write_frame,
};

const DETAIL: &str = "Plug-in hosting is not available on this platform.";

/// Reads requests until the pipe closes or `Shutdown`, answering each with the error. Returns the exit code.
pub fn serve(mut input: impl Read, mut output: impl Write) -> i32 {
    loop {
        match read_frame::<HostMessage>(&mut input) {
            Ok(HostMessage::Shutdown) | Err(FrameError::Closed) => return 0,
            Ok(_) => {
                let reply = HelperMessage::error(ErrorCode::UnsupportedPlatform, DETAIL);
                if write_frame(&mut output, &reply).is_err() {
                    return 1;
                }
            }
            Err(FrameError::Malformed(_) | FrameError::Invalid(_)) => {
                let reply =
                    HelperMessage::error(ErrorCode::BadRequest, "The request was malformed.");
                if write_frame(&mut output, &reply).is_err() {
                    return 1;
                }
            }
            Err(_) => return 1,
        }
    }
}

pub fn main() -> i32 {
    serve(std::io::stdin().lock(), std::io::stdout().lock())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tabplayer_plugin_protocol::control::Mode;

    #[test]
    fn every_request_gets_unsupported_platform_until_the_pipe_closes() {
        let mut wire = Vec::new();
        for request in [
            HostMessage::Probe {
                bundle: "x.vst3".into(),
            },
            HostMessage::Load {
                bundle: "x.vst3".into(),
                class_id: "0123456789ABCDEF0123456789ABCDEF".into(),
                sample_rate: 48_000,
                mode: Mode::Realtime,
                ring: 1,
                input_event: 2,
                output_event: 3,
                app_pid: 4,
                component: Vec::new().into(),
                controller: Vec::new().into(),
            },
            HostMessage::GetState,
        ] {
            write_frame(&mut wire, &request).unwrap();
        }
        let mut replies = Vec::new();
        assert_eq!(serve(&wire[..], &mut replies), 0);
        let mut reader = &replies[..];
        for _ in 0..3 {
            let reply = read_frame::<HelperMessage>(&mut reader).unwrap();
            assert!(matches!(
                reply,
                HelperMessage::Error {
                    code: ErrorCode::UnsupportedPlatform,
                    ..
                }
            ));
        }
        assert!(matches!(
            read_frame::<HelperMessage>(&mut reader),
            Err(FrameError::Closed)
        ));
    }

    #[test]
    fn shutdown_ends_the_stub() {
        let mut wire = Vec::new();
        write_frame(&mut wire, &HostMessage::Shutdown).unwrap();
        let mut replies = Vec::new();
        assert_eq!(serve(&wire[..], &mut replies), 0);
        assert!(replies.is_empty());
    }
}
