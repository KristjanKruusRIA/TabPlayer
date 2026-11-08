//! The main thread's side of one loaded plug-in: it answers the app's requests and relays what the core notices.
//!
//! Every call into the core is wrapped in `catch_unwind`. A panic sends `Error { Internal }` and ends the helper with
//! exit code 3, so the app sees one failed helper instead of a hang. Unsolicited messages (`StateDirty`,
//! `LatencyChanged`) are coalesced and rate limited here, because the app kills a helper that sends more than 64 a
//! second (preflight ruling P16).
use crate::{
    audio::PauseGate,
    core::{CoreError, CoreEvent, PluginCore},
};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tabplayer_plugin_protocol::{
    control::{ErrorCode, HelperMessage, HostMessage},
    state::container_len,
};

/// The exit code of a helper that panicked.
pub const EXIT_PANIC: i32 = 3;
/// The exit code of a helper whose plug-in could not go on.
pub const EXIT_FATAL: i32 = 4;

/// At least this long between two `StateDirty` messages, and between two `LatencyChanged`.
const DIRTY_INTERVAL: Duration = Duration::from_millis(250);
const LATENCY_INTERVAL: Duration = Duration::from_millis(100);

/// Where the helper's messages go.
pub trait Emit {
    fn emit(&self, message: HelperMessage);
}

/// What to do after a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flow {
    Continue,
    Exit(i32),
}

pub struct Session<C: PluginCore, E: Emit> {
    core: C,
    out: E,
    gate: Arc<PauseGate>,
    dirty_pending: bool,
    dirty_sent: Option<Instant>,
    latency_pending: Option<u32>,
    latency_sent: Option<Instant>,
}

impl<C: PluginCore, E: Emit> Session<C, E> {
    pub fn new(core: C, out: E, gate: Arc<PauseGate>) -> Session<C, E> {
        Session {
            core,
            out,
            gate,
            dirty_pending: false,
            dirty_sent: None,
            latency_pending: None,
            latency_sent: None,
        }
    }

    #[cfg(test)]
    pub fn core_mut(&mut self) -> &mut C {
        &mut self.core
    }

    /// Runs `f` on the core; a panic is reported and turned into `Err(Flow::Exit(3))`.
    fn guarded<R>(&mut self, f: impl FnOnce(&mut C) -> R) -> Result<R, Flow> {
        match catch_unwind(AssertUnwindSafe(|| f(&mut self.core))) {
            Ok(value) => Ok(value),
            Err(_) => {
                self.out.emit(HelperMessage::error(
                    ErrorCode::Internal,
                    "The plug-in host stopped unexpectedly.",
                ));
                Err(Flow::Exit(EXIT_PANIC))
            }
        }
    }

    fn fail(&self, error: CoreError) {
        self.out.emit(error.message());
    }

    /// Answers one request.
    pub fn handle(&mut self, request: HostMessage) -> Flow {
        match request {
            HostMessage::Probe { .. } | HostMessage::Load { .. } => {
                self.out.emit(HelperMessage::error(
                    ErrorCode::BadRequest,
                    "A plug-in is already loaded.",
                ));
            }
            HostMessage::SetState {
                component,
                controller,
            } => match self.guarded(|c| c.set_state(&component, &controller)) {
                Ok(Ok(())) => {}
                Ok(Err(error)) => self.fail(error),
                Err(flow) => return flow,
            },
            HostMessage::GetState => match self.guarded(|c| c.state()) {
                Ok(Ok((component, controller))) => {
                    // A state that would not fit the container is never sent: the app would refuse the frame.
                    if container_len(component.len(), controller.len()).is_none() {
                        self.out.emit(HelperMessage::error(
                            ErrorCode::StateTooLarge,
                            "The plug-in's state is too large to keep.",
                        ));
                    } else {
                        self.out.emit(HelperMessage::State {
                            component: component.into(),
                            controller: controller.into(),
                        });
                    }
                }
                Ok(Err(error)) => self.fail(error),
                Err(flow) => return flow,
            },
            HostMessage::SetParameter { id, value } => {
                let value = HostMessage::clamp_parameter(value);
                match self.guarded(|c| c.set_parameter(id, value)) {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => self.fail(error),
                    Err(flow) => return flow,
                }
            }
            HostMessage::OpenEditor { title, near } => {
                match self.guarded(|c| c.open_editor(&title, near)) {
                    Ok(Ok(window)) => self.out.emit(HelperMessage::EditorOpened { window }),
                    Ok(Err(error)) => self.fail(error),
                    Err(flow) => return flow,
                }
            }
            HostMessage::CloseEditor => {
                if let Err(flow) = self.guarded(|c| c.close_editor()) {
                    return flow;
                }
                self.out.emit(HelperMessage::EditorClosed);
            }
            HostMessage::Shutdown => return Flow::Exit(0),
        }
        Flow::Continue
    }

    /// Takes what the core noticed and sends what is due. Call it when the core asked for attention and on a timer, so a
    /// message held back by a rate limit still goes out.
    pub fn poll(&mut self) -> Flow {
        let gate = self.gate.clone();
        let events = match self.guarded(|c| c.poll(&gate)) {
            Ok(events) => events,
            Err(flow) => return flow,
        };
        for event in events {
            match event {
                CoreEvent::LatencyChanged(latency) => self.latency_pending = Some(latency),
                CoreEvent::StateDirty => self.dirty_pending = true,
                CoreEvent::Fatal(error) => {
                    self.fail(error);
                    return Flow::Exit(EXIT_FATAL);
                }
                CoreEvent::EditorClosed => self.out.emit(HelperMessage::EditorClosed),
            }
        }
        let now = Instant::now();
        if let Some(latency) = self.latency_pending
            && self
                .latency_sent
                .is_none_or(|at| now.duration_since(at) >= LATENCY_INTERVAL)
        {
            self.latency_pending = None;
            self.latency_sent = Some(now);
            self.out.emit(HelperMessage::LatencyChanged { latency });
        }
        if self.dirty_pending
            && self
                .dirty_sent
                .is_none_or(|at| now.duration_since(at) >= DIRTY_INTERVAL)
        {
            self.dirty_pending = false;
            self.dirty_sent = Some(now);
            self.out.emit(HelperMessage::StateDirty);
        }
        Flow::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::BlockProcessor;
    use std::cell::RefCell;
    use std::path::Path;
    use std::rc::Rc;
    use tabplayer_plugin_protocol::{
        control::{ClassInfo, Mode, Rect},
        limits::MAX_STATE_BYTES,
        ring::BlockMeta,
    };

    #[derive(Default)]
    struct Log(Rc<RefCell<Vec<HelperMessage>>>);
    impl Emit for Log {
        fn emit(&self, message: HelperMessage) {
            self.0.borrow_mut().push(message);
        }
    }

    struct Silent;
    impl BlockProcessor for Silent {
        fn reset(&mut self) {}
        fn process(&mut self, _: &[[f32; 2]], out: &mut [[f32; 2]], _: &BlockMeta) {
            out.iter_mut().for_each(|f| *f = [0.0; 2]);
        }
    }

    #[derive(Default)]
    struct Fake {
        class: Option<ClassInfo>,
        state: (Vec<u8>, Vec<u8>),
        reject: bool,
        panic_next: bool,
        known: Vec<u32>,
        set: Vec<(u32, f64)>,
        events: Vec<CoreEvent>,
        editor: bool,
    }
    impl PluginCore for Fake {
        fn probe(_: &Path) -> Result<Vec<ClassInfo>, CoreError> {
            Ok(Vec::new())
        }
        fn load(_: &Path, _: &str, _: u32, _: Mode) -> Result<Self, CoreError> {
            Ok(Fake::default())
        }
        fn class(&self) -> &ClassInfo {
            self.class.as_ref().unwrap()
        }
        fn mono(&self) -> bool {
            false
        }
        fn latency(&self) -> u32 {
            0
        }
        fn set_state(&mut self, component: &[u8], controller: &[u8]) -> Result<(), CoreError> {
            if self.panic_next {
                panic!("a plug-in bug");
            }
            if self.reject {
                return Err(CoreError::new(ErrorCode::RejectedState, "refused"));
            }
            self.state = (component.to_vec(), controller.to_vec());
            Ok(())
        }
        fn state(&mut self) -> Result<(Vec<u8>, Vec<u8>), CoreError> {
            Ok(self.state.clone())
        }
        fn set_parameter(&mut self, id: u32, value: f64) -> Result<(), CoreError> {
            if !self.known.contains(&id) {
                return Err(CoreError::new(ErrorCode::BadRequest, "Unknown parameter."));
            }
            self.set.push((id, value));
            Ok(())
        }
        fn processor(&mut self) -> Result<Box<dyn BlockProcessor + Send>, CoreError> {
            Ok(Box::new(Silent))
        }
        fn open_editor(&mut self, _: &str, _: Option<Rect>) -> Result<u64, CoreError> {
            self.editor = true;
            Ok(0x1234)
        }
        fn close_editor(&mut self) {
            self.editor = false;
        }
        fn poll(&mut self, _: &PauseGate) -> Vec<CoreEvent> {
            std::mem::take(&mut self.events)
        }
    }

    fn session(fake: Fake) -> (Session<Fake, Log>, Rc<RefCell<Vec<HelperMessage>>>) {
        let log = Log::default();
        let seen = log.0.clone();
        (
            Session::new(fake, log, Arc::new(PauseGate::default())),
            seen,
        )
    }

    #[test]
    fn state_round_trips_and_a_refusal_is_reported() {
        let (mut s, seen) = session(Fake::default());
        let set = HostMessage::SetState {
            component: vec![1, 2, 3].into(),
            controller: vec![4].into(),
        };
        assert_eq!(s.handle(set), Flow::Continue);
        assert!(seen.borrow().is_empty(), "SetState has no reply on success");
        s.handle(HostMessage::GetState);
        assert_eq!(
            seen.borrow().last(),
            Some(&HelperMessage::State {
                component: vec![1, 2, 3].into(),
                controller: vec![4].into()
            })
        );
        s.core_mut().reject = true;
        s.handle(HostMessage::SetState {
            component: vec![9].into(),
            controller: Vec::new().into(),
        });
        assert!(matches!(
            seen.borrow().last(),
            Some(HelperMessage::Error {
                code: ErrorCode::RejectedState,
                ..
            })
        ));
    }

    #[test]
    fn a_state_over_the_cap_is_an_error_and_is_never_sent() {
        let big = vec![0u8; MAX_STATE_BYTES];
        let (mut s, seen) = session(Fake {
            state: (big, Vec::new()),
            ..Fake::default()
        });
        s.handle(HostMessage::GetState);
        let messages = seen.borrow();
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            messages[0],
            HelperMessage::Error {
                code: ErrorCode::StateTooLarge,
                ..
            }
        ));
    }

    #[test]
    fn parameters_are_clamped_and_checked_by_the_core() {
        let (mut s, seen) = session(Fake {
            known: vec![1, 7],
            ..Fake::default()
        });
        s.handle(HostMessage::SetParameter { id: 1, value: 3.0 });
        s.handle(HostMessage::SetParameter { id: 7, value: -2.0 });
        assert_eq!(s.core_mut().set, [(1, 1.0), (7, 0.0)]);
        s.handle(HostMessage::SetParameter { id: 99, value: 0.5 });
        assert!(matches!(
            seen.borrow().last(),
            Some(HelperMessage::Error {
                code: ErrorCode::BadRequest,
                ..
            })
        ));
    }

    #[test]
    fn editor_requests_get_their_answers() {
        let (mut s, seen) = session(Fake::default());
        s.handle(HostMessage::OpenEditor {
            title: "Amp".into(),
            near: None,
        });
        s.handle(HostMessage::CloseEditor);
        assert_eq!(
            *seen.borrow(),
            [
                HelperMessage::EditorOpened { window: 0x1234 },
                HelperMessage::EditorClosed
            ]
        );
        assert!(!s.core_mut().editor);
    }

    #[test]
    fn shutdown_and_repeated_loads() {
        let (mut s, seen) = session(Fake::default());
        assert_eq!(s.handle(HostMessage::Shutdown), Flow::Exit(0));
        s.handle(HostMessage::Probe {
            bundle: "x.vst3".into(),
        });
        assert!(matches!(
            seen.borrow().last(),
            Some(HelperMessage::Error {
                code: ErrorCode::BadRequest,
                ..
            })
        ));
    }

    #[test]
    fn a_panic_in_the_core_is_reported_and_ends_the_helper() {
        let (mut s, seen) = session(Fake {
            panic_next: true,
            ..Fake::default()
        });
        let flow = s.handle(HostMessage::SetState {
            component: Vec::new().into(),
            controller: Vec::new().into(),
        });
        assert_eq!(flow, Flow::Exit(EXIT_PANIC));
        assert!(matches!(
            seen.borrow().last(),
            Some(HelperMessage::Error {
                code: ErrorCode::Internal,
                ..
            })
        ));
    }

    #[test]
    fn unsolicited_messages_are_coalesced_and_rate_limited() {
        let (mut s, seen) = session(Fake::default());
        // A burst of 1,000 edits and latency changes in one tick is one message of each kind.
        s.core_mut().events = (0..1000)
            .flat_map(|i| [CoreEvent::StateDirty, CoreEvent::LatencyChanged(i)])
            .collect();
        s.poll();
        assert_eq!(
            *seen.borrow(),
            [
                HelperMessage::LatencyChanged { latency: 999 },
                HelperMessage::StateDirty
            ]
        );
        // Straight after, more of the same is held back, not sent and not lost.
        s.core_mut().events = vec![CoreEvent::StateDirty, CoreEvent::LatencyChanged(5)];
        s.poll();
        assert_eq!(seen.borrow().len(), 2);
        std::thread::sleep(DIRTY_INTERVAL + Duration::from_millis(20));
        s.poll();
        assert_eq!(
            seen.borrow()[2..],
            [
                HelperMessage::LatencyChanged { latency: 5 },
                HelperMessage::StateDirty
            ]
        );
        // The user closing the editor is relayed at once.
        s.core_mut().events = vec![CoreEvent::EditorClosed];
        s.poll();
        assert_eq!(seen.borrow().last(), Some(&HelperMessage::EditorClosed));
    }
}
