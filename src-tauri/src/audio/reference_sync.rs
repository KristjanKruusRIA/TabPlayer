use crate::audio::plan::PlaybackPlan;
use crate::settings::BackingSettings;

#[derive(Clone, Debug)]
pub struct ReferenceSyncMap;

impl ReferenceSyncMap {
    pub fn new(_settings: &BackingSettings, _plan: &PlaybackPlan) -> Result<Self, String> {
        Err("Reference sync playback is not implemented.".into())
    }
}
