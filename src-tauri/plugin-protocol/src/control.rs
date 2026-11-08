//! The control messages between the app and one helper, and the frames that carry them.
//!
//! A frame is a `u32` little-endian length and that many bytes of JSON. The length is checked against a cap before any
//! buffer is allocated, and the body is read in bounded chunks, so a hostile length cannot make the reader allocate more
//! than the bytes that actually arrive. Every message refuses unknown fields, and every message that arrives is
//! validated ([`Message::validate`]) before the caller sees it.
use crate::{
    limits::{
        MAX_CLASSES, MAX_DETAIL_CHARS, MAX_FRAME_BYTES, MAX_PATH_CHARS, MAX_SAMPLE_RATE,
        MAX_STATE_BYTES, MAX_SUBCATEGORIES_CHARS, MAX_TITLE_CHARS, MAX_VERSION_CHARS,
        MIN_SAMPLE_RATE,
    },
    state::STATE_OVERHEAD,
    validate::{valid_class_id, valid_name, valid_text, valid_vendor},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::DeserializeOwned};
use std::io::{self, Read, Write};

/// Bytes that travel as a base64 string.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Bytes(pub Vec<u8>);

impl std::ops::Deref for Bytes {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        &self.0
    }
}
impl From<Vec<u8>> for Bytes {
    fn from(value: Vec<u8>) -> Self {
        Bytes(value)
    }
}

/// The base64 length of the largest legitimate part.
const MAX_BYTES_B64: usize = MAX_STATE_BYTES.div_ceil(3) * 4;

impl Serialize for Bytes {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&STANDARD.encode(&self.0))
    }
}

impl<'de> Deserialize<'de> for Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl serde::de::Visitor<'_> for Visitor {
            type Value = Bytes;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a base64 string")
            }
            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Bytes, E> {
                if text.len() > MAX_BYTES_B64 {
                    return Err(E::custom("base64 value is too long"));
                }
                STANDARD.decode(text).map(Bytes).map_err(E::custom)
            }
        }
        deserializer.deserialize_str(Visitor)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Live playback: the audio thread exchanges blocks with the helper through the ring.
    Realtime,
    /// Export: blocks are exchanged synchronously.
    Offline,
}

/// Where to place an editor window, in screen pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// A plug-in class a bundle offers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClassInfo {
    /// 32 uppercase hex characters.
    pub class_id: String,
    pub name: String,
    pub vendor: String,
    pub version: String,
    pub subcategories: String,
}

impl ClassInfo {
    pub fn validate(&self) -> Result<(), String> {
        if !valid_class_id(&self.class_id) {
            return Err("Invalid plug-in class ID.".into());
        }
        if !valid_name(&self.name) {
            return Err("Invalid plug-in name.".into());
        }
        if !valid_vendor(&self.vendor) {
            return Err("Invalid plug-in vendor.".into());
        }
        if !valid_text(&self.version, MAX_VERSION_CHARS, true) {
            return Err("Invalid plug-in version.".into());
        }
        if !valid_text(&self.subcategories, MAX_SUBCATEGORIES_CHARS, true) {
            return Err("Invalid plug-in categories.".into());
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// A request the helper cannot act on in its current state, or malformed.
    BadRequest,
    /// The bundle or class is not there.
    NotFound,
    /// The module would not load, crashed while loading, or is not a usable effect.
    Unreadable,
    /// An audio layout other than stereo, or a mono-only plug-in's other half.
    UnsupportedLayout,
    TooMuchLatency,
    /// The plug-in rejected a state it was given.
    RejectedState,
    /// A state the helper would produce or was given exceeds [`MAX_STATE_BYTES`].
    StateTooLarge,
    EditorFailed,
    Internal,
}

/// What the app sends. `Load` is the first message to an audio helper, `Probe` to a probing one.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostMessage {
    Probe {
        bundle: String,
    },
    Load {
        bundle: String,
        class_id: String,
        sample_rate: u32,
        mode: Mode,
        /// The duplicated handle of the ring's file mapping, as it is valid inside the helper.
        ring: u64,
        /// The duplicated auto-reset events: the app signals `input_event` after each published block and the helper
        /// signals `output_event` after each answer.
        input_event: u64,
        output_event: u64,
        /// The app's process ID, so the helper can let the app take the foreground (preflight ruling P29).
        app_pid: u32,
        component: Bytes,
        controller: Bytes,
    },
    SetState {
        component: Bytes,
        controller: Bytes,
    },
    GetState {},
    /// Sets one normalized parameter. The value is clamped to 0..=1 by the receiver; the id is checked against the
    /// plug-in's own parameter list, because VST3 parameter IDs are arbitrary 32-bit numbers.
    SetParameter {
        id: u32,
        value: f64,
    },
    OpenEditor {
        title: String,
        near: Option<Rect>,
    },
    CloseEditor {},
    Shutdown {},
}

/// What the helper sends.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HelperMessage {
    Probed {
        classes: Vec<ClassInfo>,
    },
    Loaded {
        /// The plug-in's latency in frames.
        latency: u32,
        class: ClassInfo,
        /// Whether the plug-in is mono-only, so the helper downmixes its input and duplicates its output.
        mono: bool,
    },
    State {
        component: Bytes,
        controller: Bytes,
    },
    LatencyChanged {
        latency: u32,
    },
    EditorOpened {
        window: u64,
    },
    EditorClosed {},
    StateDirty {},
    Error {
        code: ErrorCode,
        /// At most [`MAX_DETAIL_CHARS`] characters.
        detail: String,
    },
}

impl HelperMessage {
    /// An error message, with the detail cut to the cap on a character boundary.
    pub fn error(code: ErrorCode, detail: &str) -> HelperMessage {
        HelperMessage::Error {
            code,
            detail: detail.chars().take(MAX_DETAIL_CHARS).collect(),
        }
    }
}

/// A message that can be read from a frame: it is checked as soon as it is parsed.
pub trait Message: DeserializeOwned {
    fn validate(&self) -> Result<(), String>;
}

fn state_parts_fit(component: &[u8], controller: &[u8]) -> Result<(), String> {
    match component
        .len()
        .checked_add(controller.len())
        .and_then(|n| n.checked_add(STATE_OVERHEAD))
    {
        Some(total) if total <= MAX_STATE_BYTES => Ok(()),
        _ => Err("Plug-in state is too large.".into()),
    }
}

impl Message for HostMessage {
    fn validate(&self) -> Result<(), String> {
        match self {
            HostMessage::Probe { bundle } => bundle_ok(bundle),
            HostMessage::Load {
                bundle,
                class_id,
                sample_rate,
                ring,
                input_event,
                output_event,
                component,
                controller,
                ..
            } => {
                bundle_ok(bundle)?;
                if !valid_class_id(class_id) {
                    return Err("Invalid plug-in class ID.".into());
                }
                if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(sample_rate) {
                    return Err("Unsupported sample rate.".into());
                }
                if *ring == 0 || *input_event == 0 || *output_event == 0 {
                    return Err("Missing shared-memory handle.".into());
                }
                state_parts_fit(component, controller)
            }
            HostMessage::SetState {
                component,
                controller,
            } => state_parts_fit(component, controller),
            HostMessage::SetParameter { value, .. } => {
                if value.is_finite() {
                    Ok(())
                } else {
                    Err("Parameter value is not finite.".into())
                }
            }
            HostMessage::OpenEditor { title, .. } => {
                if title.chars().count() <= MAX_TITLE_CHARS
                    && valid_text(title, MAX_TITLE_CHARS, true)
                {
                    Ok(())
                } else {
                    Err("Invalid editor title.".into())
                }
            }
            HostMessage::GetState {} | HostMessage::CloseEditor {} | HostMessage::Shutdown {} => {
                Ok(())
            }
        }
    }
}

fn bundle_ok(bundle: &str) -> Result<(), String> {
    if bundle.is_empty() || bundle.chars().count() > MAX_PATH_CHARS || bundle.contains('\0') {
        Err("Invalid plug-in bundle path.".into())
    } else {
        Ok(())
    }
}

impl Message for HelperMessage {
    fn validate(&self) -> Result<(), String> {
        match self {
            HelperMessage::Probed { classes } => {
                if classes.len() > MAX_CLASSES {
                    return Err("Too many plug-in classes.".into());
                }
                classes.iter().try_for_each(ClassInfo::validate)
            }
            HelperMessage::Loaded { class, .. } => class.validate(),
            HelperMessage::State {
                component,
                controller,
            } => state_parts_fit(component, controller),
            HelperMessage::Error { detail, .. } => {
                if detail.chars().count() <= MAX_DETAIL_CHARS {
                    Ok(())
                } else {
                    Err("Error detail is too long.".into())
                }
            }
            HelperMessage::LatencyChanged { .. }
            | HelperMessage::EditorOpened { .. }
            | HelperMessage::EditorClosed {}
            | HelperMessage::StateDirty {} => Ok(()),
        }
    }
}

impl HostMessage {
    /// A normalized parameter value, clamped to 0..=1. Non-finite values are refused by `validate`; this maps one that
    /// slipped through to 0.
    pub fn clamp_parameter(value: f64) -> f64 {
        if value.is_nan() {
            0.0
        } else {
            value.clamp(0.0, 1.0)
        }
    }
}

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    /// The stream ended before the first byte of a frame: the peer closed it.
    Closed,
    /// The stream ended inside a frame.
    Truncated,
    /// The length prefix exceeds the cap. Nothing was allocated or read for the body.
    TooLarge(usize),
    /// The body is not a message of the expected type.
    Malformed(String),
    /// The message parsed but breaks a rule.
    Invalid(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => write!(f, "control pipe error: {error}"),
            Self::Closed => f.write_str("control pipe closed"),
            Self::Truncated => f.write_str("control frame is truncated"),
            Self::TooLarge(length) => write!(f, "control frame of {length} bytes is over the cap"),
            Self::Malformed(detail) => write!(f, "malformed control message: {detail}"),
            Self::Invalid(detail) => write!(f, "invalid control message: {detail}"),
        }
    }
}
impl std::error::Error for FrameError {}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// How much of a body is read at a time. The buffer grows with the bytes that arrive, never to the announced length.
const READ_CHUNK: usize = 64 << 10;

/// Writes one frame. The prefix and body go out in a single `write_all`, so frames from one writer never interleave.
pub fn write_frame<W: Write>(writer: &mut W, message: &impl Serialize) -> Result<(), FrameError> {
    let body =
        serde_json::to_vec(message).map_err(|error| FrameError::Malformed(error.to_string()))?;
    if body.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge(body.len()));
    }
    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    writer.write_all(&frame)?;
    writer.flush()?;
    Ok(())
}

/// Reads one frame of at most [`MAX_FRAME_BYTES`] and validates the message.
pub fn read_frame<T: Message>(reader: &mut impl Read) -> Result<T, FrameError> {
    read_frame_limited(reader, MAX_FRAME_BYTES)
}

/// As [`read_frame`] with a tighter cap, for the times only small messages are expected.
pub fn read_frame_limited<T: Message>(
    reader: &mut impl Read,
    limit: usize,
) -> Result<T, FrameError> {
    let mut prefix = [0u8; 4];
    let mut have = 0;
    while have < prefix.len() {
        match reader.read(&mut prefix[have..]) {
            Ok(0) if have == 0 => return Err(FrameError::Closed),
            Ok(0) => return Err(FrameError::Truncated),
            Ok(n) => have += n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.into()),
        }
    }
    let length = u32::from_le_bytes(prefix) as usize;
    if length > limit.min(MAX_FRAME_BYTES) {
        return Err(FrameError::TooLarge(length));
    }
    let mut body = Vec::new();
    while body.len() < length {
        let start = body.len();
        let end = start + READ_CHUNK.min(length - start);
        body.resize(end, 0);
        reader.read_exact(&mut body[start..end]).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                FrameError::Truncated
            } else {
                FrameError::Io(error)
            }
        })?;
    }
    let message: T =
        serde_json::from_slice(&body).map_err(|error| FrameError::Malformed(error.to_string()))?;
    message.validate().map_err(FrameError::Invalid)?;
    Ok(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::MAX_NAME_CHARS;

    const CLASS: &str = "0123456789ABCDEF0123456789ABCDEF";

    fn class() -> ClassInfo {
        ClassInfo {
            class_id: CLASS.into(),
            name: "Amp".into(),
            vendor: "Vendor".into(),
            version: "1.2.3".into(),
            subcategories: "Fx|Distortion".into(),
        }
    }

    fn host_messages() -> Vec<HostMessage> {
        vec![
            HostMessage::Probe {
                bundle: "C:\\VST3\\Amp.vst3".into(),
            },
            HostMessage::Load {
                bundle: "C:\\VST3\\Amp.vst3".into(),
                class_id: CLASS.into(),
                sample_rate: 48_000,
                mode: Mode::Realtime,
                ring: 0x1c4,
                input_event: 0x1c8,
                output_event: u64::MAX >> 1,
                app_pid: 4242,
                component: vec![1, 2, 3, 0, 255].into(),
                controller: Vec::new().into(),
            },
            HostMessage::SetState {
                component: vec![9; 100].into(),
                controller: vec![8; 10].into(),
            },
            HostMessage::GetState {},
            HostMessage::SetParameter {
                id: u32::MAX,
                value: 0.25,
            },
            HostMessage::OpenEditor {
                title: "Amp".into(),
                near: Some(Rect {
                    x: -20,
                    y: 30,
                    width: 800,
                    height: 600,
                }),
            },
            HostMessage::OpenEditor {
                title: String::new(),
                near: None,
            },
            HostMessage::CloseEditor {},
            HostMessage::Shutdown {},
        ]
    }

    fn helper_messages() -> Vec<HelperMessage> {
        vec![
            HelperMessage::Probed {
                classes: vec![class(), class()],
            },
            HelperMessage::Probed {
                classes: Vec::new(),
            },
            HelperMessage::Loaded {
                latency: 4800,
                class: class(),
                mono: true,
            },
            HelperMessage::State {
                component: vec![5; 33].into(),
                controller: vec![6; 7].into(),
            },
            HelperMessage::LatencyChanged { latency: 64 },
            HelperMessage::EditorOpened {
                window: 0xdead_beef,
            },
            HelperMessage::EditorClosed {},
            HelperMessage::StateDirty {},
            HelperMessage::error(ErrorCode::Unreadable, "it did not load"),
        ]
    }

    #[test]
    fn every_message_round_trips_through_a_frame() {
        let mut wire = Vec::new();
        for message in host_messages() {
            write_frame(&mut wire, &message).unwrap();
        }
        let mut reader = &wire[..];
        for message in host_messages() {
            assert_eq!(read_frame::<HostMessage>(&mut reader).unwrap(), message);
        }
        assert!(matches!(
            read_frame::<HostMessage>(&mut reader),
            Err(FrameError::Closed)
        ));

        let mut wire = Vec::new();
        for message in helper_messages() {
            write_frame(&mut wire, &message).unwrap();
        }
        let mut reader = &wire[..];
        for message in helper_messages() {
            assert_eq!(read_frame::<HelperMessage>(&mut reader).unwrap(), message);
        }
    }

    #[test]
    fn wire_names_are_camel_case_and_bytes_are_base64() {
        let json = serde_json::to_string(&HostMessage::SetState {
            component: vec![0xfb, 0xff].into(),
            controller: Vec::new().into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"setState","component":"+/8=","controller":""}"#
        );
        let json = serde_json::to_string(&HelperMessage::EditorOpened { window: 7 }).unwrap();
        assert_eq!(json, r#"{"type":"editorOpened","window":7}"#);
        assert_eq!(
            serde_json::to_string(&HostMessage::Shutdown {}).unwrap(),
            r#"{"type":"shutdown"}"#
        );
        let load = serde_json::to_value(&host_messages()[1]).unwrap();
        for key in [
            "classId",
            "sampleRate",
            "inputEvent",
            "outputEvent",
            "appPid",
        ] {
            assert!(load.get(key).is_some(), "{key}");
        }
    }

    #[test]
    fn messages_refuse_unknown_fields_and_long_names() {
        // Unknown fields, in struct variants, unit-like variants, nested structs and unknown variants.
        for json in [
            r#"{"type":"probe","bundle":"a","extra":1}"#,
            r#"{"type":"shutdown","extra":1}"#,
            r#"{"type":"getState","extra":true}"#,
            r#"{"type":"openEditor","title":"","near":{"x":0,"y":0,"width":1,"height":1,"z":0}}"#,
            r#"{"type":"setParameter","id":1,"value":0.5,"extra":0}"#,
            r#"{"type":"nope"}"#,
            r#"{"bundle":"a"}"#,
            r#"{"type":"setState","component":"AAAA"}"#,
            r#"{"type":"setState","component":"not base64!","controller":""}"#,
        ] {
            assert!(serde_json::from_str::<HostMessage>(json).is_err(), "{json}");
        }
        for json in [
            r#"{"type":"editorClosed","extra":1}"#,
            r#"{"type":"stateDirty","extra":1}"#,
            r#"{"type":"error","code":"internal","detail":"","extra":1}"#,
            r#"{"type":"error","code":"unknownCode","detail":""}"#,
            r#"{"type":"latencyChanged","latency":-1}"#,
        ] {
            assert!(
                serde_json::from_str::<HelperMessage>(json).is_err(),
                "{json}"
            );
        }
        let class_json = |extra: &str| {
            format!(
                r#"{{"type":"loaded","latency":0,"mono":false,"class":{{"classId":"{CLASS}","name":"A","vendor":"","version":"","subcategories":""{extra}}}}}"#
            )
        };
        assert!(serde_json::from_str::<HelperMessage>(&class_json("")).is_ok());
        assert!(serde_json::from_str::<HelperMessage>(&class_json(r#","extra":1"#)).is_err());

        // Long names and details, refused when a frame carries them.
        let frame = |message: &HelperMessage| {
            let mut wire = Vec::new();
            write_frame(&mut wire, message).unwrap();
            read_frame::<HelperMessage>(&mut &wire[..])
        };
        let mut long = class();
        long.name = "x".repeat(MAX_NAME_CHARS + 1);
        assert!(matches!(
            frame(&HelperMessage::Loaded {
                latency: 0,
                class: long,
                mono: false
            }),
            Err(FrameError::Invalid(_))
        ));
        let mut long = class();
        long.vendor = "v".repeat(MAX_NAME_CHARS + 1);
        assert!(matches!(
            frame(&HelperMessage::Probed {
                classes: vec![long]
            }),
            Err(FrameError::Invalid(_))
        ));
        let detail = HelperMessage::Error {
            code: ErrorCode::Internal,
            detail: "d".repeat(MAX_DETAIL_CHARS + 1),
        };
        assert!(matches!(frame(&detail), Err(FrameError::Invalid(_))));
        assert!(
            frame(&HelperMessage::Error {
                code: ErrorCode::Internal,
                detail: "d".repeat(MAX_DETAIL_CHARS)
            })
            .is_ok()
        );
        // The constructor cuts, on a character boundary.
        let HelperMessage::Error { detail, .. } =
            HelperMessage::error(ErrorCode::Internal, &"\u{e9}".repeat(1000))
        else {
            panic!()
        };
        assert_eq!(detail.chars().count(), MAX_DETAIL_CHARS);
        // Too many classes.
        let classes = vec![class(); MAX_CLASSES + 1];
        assert!(matches!(
            frame(&HelperMessage::Probed { classes }),
            Err(FrameError::Invalid(_))
        ));
        assert!(
            frame(&HelperMessage::Probed {
                classes: vec![class(); MAX_CLASSES]
            })
            .is_ok()
        );
    }

    #[test]
    fn host_messages_are_checked_on_arrival() {
        let frame = |message: &HostMessage| {
            let mut wire = Vec::new();
            write_frame(&mut wire, message).unwrap();
            read_frame::<HostMessage>(&mut &wire[..])
        };
        let load = |edit: &dyn Fn(&mut HostMessage)| {
            let mut message = host_messages()[1].clone();
            edit(&mut message);
            message
        };
        assert!(frame(&host_messages()[1]).is_ok());
        assert!(matches!(
            frame(&load(&|m| if let HostMessage::Load { class_id, .. } = m {
                *class_id = "abc".into()
            })),
            Err(FrameError::Invalid(_))
        ));
        assert!(matches!(
            frame(&load(
                &|m| if let HostMessage::Load { sample_rate, .. } = m {
                    *sample_rate = 0
                }
            )),
            Err(FrameError::Invalid(_))
        ));
        assert!(matches!(
            frame(&load(&|m| if let HostMessage::Load { ring, .. } = m {
                *ring = 0
            })),
            Err(FrameError::Invalid(_))
        ));
        assert!(matches!(
            frame(&load(&|m| if let HostMessage::Load { bundle, .. } = m {
                bundle.clear()
            })),
            Err(FrameError::Invalid(_))
        ));
        assert!(matches!(
            frame(&load(&|m| if let HostMessage::Load { component, .. } = m {
                *component = vec![0; MAX_STATE_BYTES].into()
            })),
            Err(FrameError::Invalid(_))
        ));
        assert!(matches!(
            frame(&HostMessage::SetParameter {
                id: 1,
                value: f64::NAN
            }),
            Err(FrameError::Malformed(_)) | Err(FrameError::Invalid(_))
        ));
        assert_eq!(HostMessage::clamp_parameter(2.0), 1.0);
        assert_eq!(HostMessage::clamp_parameter(-1.0), 0.0);
        assert_eq!(HostMessage::clamp_parameter(f64::NAN), 0.0);
        assert_eq!(HostMessage::clamp_parameter(0.5), 0.5);
    }

    #[test]
    fn class_info_refuses_bad_class_ids() {
        assert!(class().validate().is_ok());
        for bad in [
            "",
            "0123456789ABCDEF0123456789ABCDE",
            "0123456789ABCDEF0123456789ABCDEF0",
            "0123456789abcdef0123456789abcdef",
            "0123456789ABCDEF0123456789ABCDEG",
            "{0123456789ABCDEF0123456789ABCDEF}",
        ] {
            let mut info = class();
            info.class_id = bad.into();
            assert!(info.validate().is_err(), "{bad:?}");
        }
        let mut info = class();
        info.version = "v".repeat(MAX_VERSION_CHARS + 1);
        assert!(info.validate().is_err());
        let mut info = class();
        info.subcategories = "s".repeat(MAX_SUBCATEGORIES_CHARS + 1);
        assert!(info.validate().is_err());
        let mut info = class();
        info.subcategories = "s".repeat(MAX_SUBCATEGORIES_CHARS);
        info.version = "v".repeat(MAX_VERSION_CHARS);
        assert!(info.validate().is_ok());
        let mut info = class();
        info.name = String::new();
        assert!(info.validate().is_err());
    }

    #[test]
    fn frames_refuse_bad_lengths_and_bodies() {
        let read = |bytes: &[u8]| read_frame::<HostMessage>(&mut &bytes[..]);
        assert!(matches!(read(&[]), Err(FrameError::Closed)));
        assert!(matches!(read(&[1, 0]), Err(FrameError::Truncated)));
        assert!(matches!(
            read(&[10, 0, 0, 0, b'{']),
            Err(FrameError::Truncated)
        ));
        assert!(matches!(read(&[0, 0, 0, 0]), Err(FrameError::Malformed(_))));
        assert!(matches!(
            read(&[2, 0, 0, 0, b'{', b'}']),
            Err(FrameError::Malformed(_))
        ));
        assert!(matches!(read(&[u8::MAX; 4]), Err(FrameError::TooLarge(_))));
        let mut over = ((MAX_FRAME_BYTES + 1) as u32).to_le_bytes().to_vec();
        over.extend_from_slice(b"{}");
        assert!(matches!(read(&over), Err(FrameError::TooLarge(n)) if n == MAX_FRAME_BYTES + 1));
        // A tighter limit.
        let mut wire = Vec::new();
        write_frame(
            &mut wire,
            &HostMessage::SetState {
                component: vec![0; 5000].into(),
                controller: Vec::new().into(),
            },
        )
        .unwrap();
        assert!(matches!(
            read_frame_limited::<HostMessage>(&mut &wire[..], 1000),
            Err(FrameError::TooLarge(_))
        ));
        assert!(read_frame_limited::<HostMessage>(&mut &wire[..], 1 << 20).is_ok());
    }

    #[test]
    fn a_state_at_the_cap_fits_in_a_frame() {
        // The largest legitimate state: the whole container at the cap, split into its two parts.
        let component = vec![0xA5u8; MAX_STATE_BYTES - STATE_OVERHEAD - 1000];
        let message = HelperMessage::State {
            component: component.into(),
            controller: vec![0x5A; 1000].into(),
        };
        let mut wire = Vec::new();
        write_frame(&mut wire, &message).unwrap();
        assert!(wire.len() - 4 <= MAX_FRAME_BYTES, "{} bytes", wire.len());
        assert_eq!(
            read_frame::<HelperMessage>(&mut &wire[..]).unwrap(),
            message
        );
        // One byte more is refused by validation, not by the frame.
        let over = HelperMessage::State {
            component: vec![0; MAX_STATE_BYTES].into(),
            controller: Vec::new().into(),
        };
        let mut wire = Vec::new();
        write_frame(&mut wire, &over).unwrap();
        assert!(matches!(
            read_frame::<HelperMessage>(&mut &wire[..]),
            Err(FrameError::Invalid(_))
        ));
    }
}
