//! Neural Amp Modeler (`.nam`) captures.
//!
//! `file` holds the bounded parser. Files are untrusted: every cap is checked
//! before anything is sized from the file's own numbers.

mod file;
mod lstm;
mod model;
mod raw;
mod wavenet;

pub use file::*;
pub use model::{NamModel, NamState};

#[cfg(test)]
mod engine_tests;
#[cfg(test)]
mod tests;
