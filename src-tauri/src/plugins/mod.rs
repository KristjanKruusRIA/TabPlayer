//! VST3 plug-in hosting, app side (THE-71). This module holds what the document needs of it (the state container and the
//! asset rules) and the client of the out-of-process plug-in helper: launching it, talking to it, watching it and killing
//! it, and the library of plug-ins the user picked. The audio path that uses the ring comes in later tasks.
pub mod bridge;
pub mod commands;
pub mod consent;
pub mod helper;
pub mod library;
pub mod service;
pub mod state;
pub mod status;
pub mod supervisor;
