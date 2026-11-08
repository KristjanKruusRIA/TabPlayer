//! The plug-in state container: what a document stores as one content-addressed asset, and what crosses the control
//! pipe in `Load` and `SetState` as two parts.
//!
//! ```text
//! "TPVST3ST" | u32 LE version (1) | u32 LE component length | component | u32 LE controller length | controller
//! ```
//!
//! No trailing bytes. The whole container is at most [`MAX_STATE_BYTES`], framing included. Both sides decode with
//! [`decode_state`], so a state one side produces is never refused by the other for a different cap (preflight ruling
//! P10).
use crate::limits::MAX_STATE_BYTES;

pub const STATE_MAGIC: &[u8; 8] = b"TPVST3ST";
pub const STATE_VERSION: u32 = 1;
/// Bytes of framing around the two parts: magic, version and two lengths.
pub const STATE_OVERHEAD: usize = 8 + 4 + 4 + 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateError {
    /// The container, or the parts that would make it, exceed [`MAX_STATE_BYTES`].
    TooLarge,
    /// Shorter than its own framing says.
    Truncated,
    BadMagic,
    BadVersion,
    /// A length that does not fit the container.
    BadLength,
    /// Bytes after the controller part.
    TrailingBytes,
}

impl std::fmt::Display for StateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "plug-in state is too large",
            Self::Truncated => "plug-in state is truncated",
            Self::BadMagic => "plug-in state has an unknown format",
            Self::BadVersion => "plug-in state has an unsupported version",
            Self::BadLength => "plug-in state has an invalid length",
            Self::TrailingBytes => "plug-in state has trailing bytes",
        })
    }
}
impl std::error::Error for StateError {}

/// The size of the container for these parts, or `None` when it would overflow or pass the cap.
pub fn container_len(component: usize, controller: usize) -> Option<usize> {
    let total = STATE_OVERHEAD
        .checked_add(component)?
        .checked_add(controller)?;
    (total <= MAX_STATE_BYTES).then_some(total)
}

pub fn encode_state(component: &[u8], controller: &[u8]) -> Result<Vec<u8>, StateError> {
    let total = container_len(component.len(), controller.len()).ok_or(StateError::TooLarge)?;
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(STATE_MAGIC);
    out.extend_from_slice(&STATE_VERSION.to_le_bytes());
    out.extend_from_slice(&(component.len() as u32).to_le_bytes());
    out.extend_from_slice(component);
    out.extend_from_slice(&(controller.len() as u32).to_le_bytes());
    out.extend_from_slice(controller);
    debug_assert_eq!(out.len(), total);
    Ok(out)
}

/// Splits a container into its component and controller parts, borrowing from `bytes`. The size is checked before
/// anything else, then every length against what remains.
pub fn decode_state(bytes: &[u8]) -> Result<(&[u8], &[u8]), StateError> {
    if bytes.len() > MAX_STATE_BYTES {
        return Err(StateError::TooLarge);
    }
    if bytes.len() < STATE_OVERHEAD {
        return Err(StateError::Truncated);
    }
    if &bytes[..8] != STATE_MAGIC {
        return Err(StateError::BadMagic);
    }
    if u32_at(bytes, 8) != STATE_VERSION {
        return Err(StateError::BadVersion);
    }
    let component_len = u32_at(bytes, 12) as usize;
    let component_end = 16usize
        .checked_add(component_len)
        .ok_or(StateError::BadLength)?;
    // The controller length field needs four more bytes after the component.
    if component_end
        .checked_add(4)
        .is_none_or(|end| end > bytes.len())
    {
        return Err(StateError::BadLength);
    }
    let controller_len = u32_at(bytes, component_end) as usize;
    let controller_start = component_end + 4;
    let controller_end = controller_start
        .checked_add(controller_len)
        .ok_or(StateError::BadLength)?;
    if controller_end > bytes.len() {
        return Err(StateError::BadLength);
    }
    if controller_end < bytes.len() {
        return Err(StateError::TrailingBytes);
    }
    Ok((
        &bytes[16..component_end],
        &bytes[controller_start..controller_end],
    ))
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn container_round_trip() {
        for (component, controller) in [
            (&b""[..], &b""[..]),
            (b"abc", b""),
            (b"", b"xyz"),
            (b"component bytes", b"controller bytes"),
        ] {
            let bytes = encode_state(component, controller).unwrap();
            assert_eq!(
                bytes.len(),
                STATE_OVERHEAD + component.len() + controller.len()
            );
            assert_eq!(&bytes[..8], b"TPVST3ST");
            assert_eq!(decode_state(&bytes), Ok((component, controller)));
        }
        let big = vec![7u8; 1 << 20];
        let bytes = encode_state(&big, &big).unwrap();
        assert_eq!(decode_state(&bytes), Ok((&big[..], &big[..])));
    }

    #[test]
    fn container_refuses_bad_magic_version_lengths_trailing_bytes_and_oversize() {
        let good = encode_state(b"abc", b"de").unwrap();
        // magic
        let mut bad = good.clone();
        bad[0] ^= 1;
        assert_eq!(decode_state(&bad), Err(StateError::BadMagic));
        // version
        let mut bad = good.clone();
        bad[8] = 2;
        assert_eq!(decode_state(&bad), Err(StateError::BadVersion));
        // component length past the end, and u32::MAX
        for length in [4u32, u32::MAX] {
            let mut bad = good.clone();
            bad[12..16].copy_from_slice(&length.to_le_bytes());
            assert_eq!(decode_state(&bad), Err(StateError::BadLength), "{length}");
        }
        // controller length past the end, and u32::MAX
        for length in [3u32, u32::MAX] {
            let mut bad = good.clone();
            let at = 16 + 3;
            bad[at..at + 4].copy_from_slice(&length.to_le_bytes());
            assert_eq!(decode_state(&bad), Err(StateError::BadLength), "{length}");
        }
        // trailing bytes, and a controller length too short for the bytes that follow it
        let mut bad = good.clone();
        bad.push(0);
        assert_eq!(decode_state(&bad), Err(StateError::TrailingBytes));
        let mut bad = good.clone();
        let at = 16 + 3;
        bad[at..at + 4].copy_from_slice(&1u32.to_le_bytes());
        assert_eq!(decode_state(&bad), Err(StateError::TrailingBytes));
        // truncation, at every length
        for cut in 0..good.len() {
            assert!(decode_state(&good[..cut]).is_err(), "cut at {cut}");
        }
        // oversize, in both directions
        assert_eq!(
            encode_state(&vec![0; MAX_STATE_BYTES], b""),
            Err(StateError::TooLarge)
        );
        assert_eq!(
            encode_state(&vec![0; MAX_STATE_BYTES - STATE_OVERHEAD + 1], b""),
            Err(StateError::TooLarge)
        );
        assert!(encode_state(&vec![0; MAX_STATE_BYTES - STATE_OVERHEAD], b"").is_ok());
        assert_eq!(
            decode_state(&vec![0; MAX_STATE_BYTES + 1]),
            Err(StateError::TooLarge)
        );
        assert_eq!(container_len(usize::MAX, 1), None);
    }
}
