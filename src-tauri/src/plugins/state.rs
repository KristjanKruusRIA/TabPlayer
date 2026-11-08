//! A plug-in's saved state in a document: one content-addressed asset holding the container that
//! `tabplayer-plugin-protocol` defines, and the caps on those assets.
//!
//! The container, its 8 MiB cap and its codec are the protocol crate's, re-exported here so the app and the helper can
//! never disagree about them (preflight ruling P10). This module adds only what the document needs: the asset's name
//! and type, and the size checks that run on base64 text before anything is decoded (P17).
use crate::assets::StoredAsset;
use std::collections::{BTreeMap, BTreeSet};

pub use tabplayer_plugin_protocol::{
    MAX_STATE_BYTES,
    state::{
        STATE_MAGIC, STATE_OVERHEAD, STATE_VERSION, StateError, container_len, decode_state,
        encode_state,
    },
};

pub const STATE_FILENAME: &str = "plugin-state.tpstate";
pub const STATE_MEDIA_TYPE: &str = "application/x-tabplayer-plugin-state";
/// The distinct state assets of one document, raw, summed over its baseline, its edits and the ones undone.
pub const MAX_PROJECT_STATE_BYTES: usize = 64 << 20;
/// The longest base64 text of one state asset: a container of [`MAX_STATE_BYTES`] encoded.
pub const MAX_STATE_BASE64_LEN: usize = MAX_STATE_BYTES.div_ceil(3) * 4;

/// What the document says when an edit names state that the project does not hold.
pub const MISSING_MESSAGE: &str = "Plug-in settings are missing from this project.";
pub const MISSING_FROM_RECOVERY_MESSAGE: &str = "Saved plug-in settings are missing from recovery.";
pub const TOO_LARGE_MESSAGE: &str = "Plug-in settings are too large.";
/// The history already holds all the plug-in state it may; the interface shows this as `plugin.history_full`.
pub const HISTORY_FULL_MESSAGE: &str = "The undo history holds as much plug-in state as it can.";

/// Whether an asset is a plug-in state by its type, which is all that is known of it before an edit names it.
pub fn is_state_asset(asset: &StoredAsset) -> bool {
    asset.media_type == STATE_MEDIA_TYPE
}

/// Refuses an asset that is, or is named as, a plug-in state when its base64 text is longer than a state can be. It reads
/// no bytes, so an oversized asset costs nothing to refuse: call it before `StoredAsset::bytes`, `id` or `validate`.
pub fn check_size_before_decode(asset: &StoredAsset, named_by_slot: bool) -> Result<(), String> {
    if (named_by_slot || is_state_asset(asset)) && asset.bytes_base64.len() > MAX_STATE_BASE64_LEN {
        return Err(TOO_LARGE_MESSAGE.into());
    }
    Ok(())
}

/// The raw length of base64 text, from its length and padding. It is exact for text that decodes, and it never decodes.
pub fn decoded_len(base64: &str) -> usize {
    let padding = base64.bytes().rev().take(2).filter(|b| *b == b'=').count();
    (base64.len() / 4 * 3).saturating_sub(padding)
}

/// Refuses a set of state assets whose raw sizes total more than [`MAX_PROJECT_STATE_BYTES`]. `ids` are the distinct ids
/// the document names; each is looked up in `assets`, then in `staged`. Ids that neither holds count for nothing here,
/// because a missing asset is refused on its own.
pub fn check_total(
    ids: &BTreeSet<&str>,
    assets: &BTreeMap<String, StoredAsset>,
    staged: Option<(&str, &StoredAsset)>,
) -> Result<(), String> {
    let mut total = 0usize;
    for id in ids {
        let asset = assets.get(*id).or_else(|| {
            staged
                .filter(|(staged_id, _)| staged_id == id)
                .map(|(_, asset)| asset)
        });
        if let Some(asset) = asset {
            total = total.saturating_add(decoded_len(&asset.bytes_base64));
        }
    }
    if total > MAX_PROJECT_STATE_BYTES {
        return Err(HISTORY_FULL_MESSAGE.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caps_are_the_protocols() {
        assert_eq!(MAX_STATE_BYTES, 8 << 20);
        assert_eq!(MAX_PROJECT_STATE_BYTES, 64 << 20);
        assert_eq!(STATE_OVERHEAD, 20);
        assert_eq!(MAX_STATE_BASE64_LEN, 11_184_812);
        // A container at the cap encodes to exactly the longest base64 text.
        let full = vec![0u8; MAX_STATE_BYTES];
        assert_eq!(
            StoredAsset::from_bytes("s".into(), STATE_MEDIA_TYPE.into(), &full)
                .bytes_base64
                .len(),
            MAX_STATE_BASE64_LEN
        );
    }

    #[test]
    fn container_round_trip() {
        for (component, controller) in [
            (&b""[..], &b""[..]),
            (b"component", b"controller"),
            (b"", b"only controller"),
            (&[7u8; 1000][..], &[9u8; 3][..]),
        ] {
            let bytes = encode_state(component, controller).unwrap();
            assert_eq!(
                bytes.len(),
                STATE_OVERHEAD + component.len() + controller.len()
            );
            assert_eq!(&bytes[..8], STATE_MAGIC);
            assert_eq!(decode_state(&bytes).unwrap(), (component, controller));
        }
    }

    #[test]
    fn container_refuses_bad_magic_version_lengths_trailing_bytes_and_oversize() {
        let good = encode_state(b"abc", b"de").unwrap();
        let mut magic = good.clone();
        magic[0] ^= 1;
        assert_eq!(decode_state(&magic), Err(StateError::BadMagic));
        let mut version = good.clone();
        version[8] = 2;
        assert_eq!(decode_state(&version), Err(StateError::BadVersion));
        let mut component_length = good.clone();
        component_length[12] = 200;
        assert_eq!(decode_state(&component_length), Err(StateError::BadLength));
        let mut controller_length = good.clone();
        controller_length[16 + 3] = 200;
        assert_eq!(decode_state(&controller_length), Err(StateError::BadLength));
        let mut trailing = good.clone();
        trailing.push(0);
        assert_eq!(decode_state(&trailing), Err(StateError::TrailingBytes));
        assert_eq!(decode_state(&good[..10]), Err(StateError::Truncated));
        assert_eq!(
            decode_state(&vec![0u8; MAX_STATE_BYTES + 1]),
            Err(StateError::TooLarge)
        );
        assert_eq!(
            encode_state(&vec![0u8; MAX_STATE_BYTES], b""),
            Err(StateError::TooLarge)
        );
        // The cap counts the framing: the largest parts fit exactly.
        assert!(encode_state(&vec![0u8; MAX_STATE_BYTES - STATE_OVERHEAD], b"").is_ok());
    }

    #[test]
    fn decoded_length_reads_padding_without_decoding() {
        for len in 0..40usize {
            let asset = StoredAsset::from_bytes("a".into(), "b".into(), &vec![1u8; len]);
            assert_eq!(decoded_len(&asset.bytes_base64), len);
        }
    }

    #[test]
    fn size_check_applies_to_state_types_and_named_assets_only() {
        let long = |media: &str| StoredAsset {
            filename: "x".into(),
            media_type: media.into(),
            bytes_base64: "A".repeat(MAX_STATE_BASE64_LEN + 4).into(),
        };
        assert_eq!(
            check_size_before_decode(&long(STATE_MEDIA_TYPE), false),
            Err(TOO_LARGE_MESSAGE.to_string())
        );
        assert_eq!(
            check_size_before_decode(&long("audio/wav"), true),
            Err(TOO_LARGE_MESSAGE.to_string())
        );
        // Backing audio is unchanged: it is not a state and no slot names it.
        assert!(check_size_before_decode(&long("audio/wav"), false).is_ok());
    }
}
