# Backlog

Product ideas that sit outside the GP8 parity tracker. Nothing here is scheduled.

## Load VST plug-ins on a track (requested 2026-10-30)

Slice 1 (spikes) and Slice 2 (first shippable slice for Windows x64, VST3) are complete under Linear THE-71. See the design specification in `docs/superpowers/specs/2026-11-07-vst-hosting-design.md` and the validation report in `docs/validation/2026-11-08-vst-hosting.md`.

**Instrument hosting is done for Windows (THE-218, 2026-11-17).** A drum track can hold a VST3 instrument, which plays the track from the score's notes; see `docs/validation/2026-11-17-vst-instruments.md`. Still open from it:
- **Drum maps (THE-219).** Notes go out with the General MIDI keys as written, so articulations that share a key cannot be told apart.
- **Controllers.** Hi-hat openness, program changes and pitch bend are not sent.
- **Multi-output.** Only the main stereo output is used, so kit presets that route drums elsewhere are silent there.
- **Warm-up for streaming samplers.** A library that loads samples in the background can give silent first hits or a silent start of an export.
- **Instruments on pitched tracks.** Instruments are for drum tracks only, one slot per track.
- **Re-striking held notes** after a seek or at the start of a range export, and a release for an instrument that is swapped out mid-note.

Remaining slices open for future development:
- **Slice 3: Folder scanning.** Scanning the standard VST3 folders, with a per-file probe timeout, a persistent cache, and a blocklist.
- **Slice 4: macOS and Linux helpers.** macOS out-of-process helper (NSWindow, library-validation entitlement, notarisation) and Linux helper (X11 and `IRunLoop`).
- **Slice 5: CLAP hosting.** CLAP support through `clack-host`, using the same helper IPC protocol.
- **Slice 6: Extended features.** Macro knobs and parameter automation, `.vstpreset` exchange, A/B auditioning against the built-in tone, Line-In live monitoring through a plug-in, shared helpers, multiple plug-in slots per track, and track freeze to audio.
