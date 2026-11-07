//! Neural Amp Modeler (`.nam`) captures.
//!
//! `file` holds the bounded parser. Files are untrusted: every cap is checked
//! before anything is sized from the file's own numbers.

mod cost;
mod file;
mod lstm;
mod model;
mod raw;
mod resample;
mod stage;
mod wavenet;

pub use cost::*;
pub use file::*;
pub use model::{NamModel, NamState};
pub use stage::{CaptureStage, OUTPUT_CEILING};

#[cfg(test)]
mod cost_tests;
#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod stage_tests;
#[cfg(test)]
mod tests;
