//! Silent output for the desktop test build.
//!
//! The desktop drivers press Play and read the meters, status and exported files; they never listen. With
//! this mode on, the stream callback renders, meters and counts frames exactly as it always does, and only the
//! samples handed to the device are replaced by silence, so timing, underruns and peaks stay real. The mode
//! exists only in a build with the `desktop-test` feature: a shipping build has no flag, no environment read and
//! no zeroing branch, and a compile-time assertion below keeps it so.
//!
//! The flag is read from `TABPLAYER_TEST_SILENT_OUTPUT` once, at start-up, off the audio thread. It is on by
//! default; `0` turns it off for someone who wants to hear the run.

#[cfg(feature = "desktop-test")]
mod enabled {
    use std::sync::atomic::{AtomicBool, Ordering};

    static SILENT: AtomicBool = AtomicBool::new(false);

    /// Whether the variable's value asks for sound; anything but `0` leaves the output silent.
    pub(super) fn requested(value: Option<&std::ffi::OsStr>) -> bool {
        value != Some(std::ffi::OsStr::new("0"))
    }

    /// Reads the environment once. Call it at start-up, before any stream exists.
    pub fn init_from_env() {
        let value = std::env::var_os("TABPLAYER_TEST_SILENT_OUTPUT");
        SILENT.store(requested(value.as_deref()), Ordering::Relaxed);
    }

    /// One relaxed atomic load: safe on the audio thread. False until `init_from_env` has run.
    pub fn active() -> bool {
        SILENT.load(Ordering::Relaxed)
    }
}

#[cfg(feature = "desktop-test")]
pub use enabled::{active, init_from_env};

/// A shipping build is never silent. `const`, so the assertion below is checked by the compiler.
#[cfg(not(feature = "desktop-test"))]
pub const fn active() -> bool {
    false
}

#[cfg(not(feature = "desktop-test"))]
const _: () = assert!(
    !active(),
    "silent output must not exist in a shipping build"
);

/// Replaces a block of device samples by silence when `silent` is set. The block has already been metered and
/// counted by the renderer, so only what the device receives changes. No allocation, lock or blocking.
#[cfg(feature = "desktop-test")]
pub fn silence_block<T: cpal::SizedSample + cpal::FromSample<f32>>(block: &mut [T], silent: bool) {
    if silent {
        block.fill(T::from_sample(0.0));
    }
}

#[cfg(all(test, feature = "desktop-test"))]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn only_zero_asks_for_sound() {
        assert!(requested_for(None));
        assert!(requested_for(Some("1")));
        assert!(requested_for(Some("")));
        assert!(!requested_for(Some("0")));
    }

    fn requested_for(value: Option<&str>) -> bool {
        enabled::requested(value.map(OsStr::new))
    }

    #[test]
    fn a_silent_block_is_all_zeros_whatever_the_sample_type() {
        let mut floats = [0.5f32, -1.0, 0.25, 0.9];
        silence_block(&mut floats, true);
        assert!(floats.iter().all(|s| *s == 0.0));
        let mut ints = [1234i16, -32768, 77, 5];
        silence_block(&mut ints, true);
        assert!(ints.iter().all(|s| *s == 0));
        let mut unsigned = [40000u16, 1, 65535, 2];
        silence_block(&mut unsigned, true);
        let midpoint: u16 = cpal::FromSample::from_sample_(0.0f32);
        assert!(unsigned.iter().all(|s| *s == midpoint));
    }

    #[test]
    fn an_audible_block_is_left_alone() {
        let mut floats = [0.5f32, -1.0];
        silence_block(&mut floats, false);
        assert_eq!(floats, [0.5, -1.0]);
    }
}
