//! Neural Amp Modeler (`.nam`) captures.
//!
//! `file` holds the bounded parser. Files are untrusted: every cap is checked
//! before anything is sized from the file's own numbers.

mod file;
mod raw;

pub use file::*;

#[cfg(test)]
mod tests;
