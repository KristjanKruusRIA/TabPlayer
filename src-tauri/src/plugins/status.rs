//! What the app tells the user about a plug-in slot (THE-71).
use serde::{Deserialize, Serialize};

/// The state of one plug-in slot. The names go to the front end as `camelCase` strings.
///
/// Only some of these come from the helper client: `Crashed`, `Hung`, `Unreadable`, `TooMuchLatency`, `RejectedState`,
/// `Underrun`, `NonFinite`, `Missing`, `HostMissing` and `UnsupportedPlatform`. The rest (`Ready`, `Loading`,
/// `NeedsConsent`, `TooMany`) belong to the service that decides whether a helper is started at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginStatus {
    Ready,
    Loading,
    /// The plug-in file is gone.
    Missing,
    /// The module would not load, is not a usable effect, or the helper broke the protocol.
    Unreadable,
    /// The helper ended without being asked to.
    Crashed,
    /// The helper stopped answering while audio was waiting for it, and was killed.
    Hung,
    NeedsConsent,
    UnsupportedPlatform,
    /// The plug-in reports a latency over a tenth of a second.
    TooMuchLatency,
    /// The plug-in refused the state it was given.
    RejectedState,
    /// The helper did not return a block in time.
    Underrun,
    /// The helper returned a block with a NaN or an infinity in it.
    NonFinite,
    /// More active slots than the app runs at once.
    TooMany,
    /// The helper program is not where the app expects it.
    HostMissing,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_are_camel_case_strings() {
        let all = [
            (PluginStatus::Ready, "ready"),
            (PluginStatus::Loading, "loading"),
            (PluginStatus::Missing, "missing"),
            (PluginStatus::Unreadable, "unreadable"),
            (PluginStatus::Crashed, "crashed"),
            (PluginStatus::Hung, "hung"),
            (PluginStatus::NeedsConsent, "needsConsent"),
            (PluginStatus::UnsupportedPlatform, "unsupportedPlatform"),
            (PluginStatus::TooMuchLatency, "tooMuchLatency"),
            (PluginStatus::RejectedState, "rejectedState"),
            (PluginStatus::Underrun, "underrun"),
            (PluginStatus::NonFinite, "nonFinite"),
            (PluginStatus::TooMany, "tooMany"),
            (PluginStatus::HostMissing, "hostMissing"),
        ];
        for (status, text) in all {
            assert_eq!(
                serde_json::to_string(&status).unwrap(),
                format!("\"{text}\"")
            );
            assert_eq!(
                serde_json::from_str::<PluginStatus>(&format!("\"{text}\"")).unwrap(),
                status
            );
        }
        assert!(serde_json::from_str::<PluginStatus>("\"Ready\"").is_err());
    }
}
