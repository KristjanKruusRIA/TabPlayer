//! The wire protocol between TabPlayer and its VST3 helper process (THE-71).
//!
//! Three parts, all pure data and no plug-in code:
//! - [`ring`]: the shared-memory audio ring. Blocks of [`limits::BLOCK_FRAMES`] frames cross it in both directions, and
//!   neither side trusts an index or a sample the other side wrote.
//! - [`control`]: the control messages, framed as a `u32` little-endian length and a JSON body, with the length checked
//!   before anything is allocated.
//! - [`state`] and [`validate`]: the plug-in state container, its cap and the class ID and name rules. This crate is the
//!   single source for them: the app re-exports them and the helper enforces the same cap (preflight ruling P10).
//!
//! The app depends on this crate only. It never links a plug-in and never loads one.

pub mod control;
pub mod limits;
pub mod ring;
pub mod state;
pub mod validate;

pub use limits::*;
