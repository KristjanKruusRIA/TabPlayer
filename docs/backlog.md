# Backlog

Product ideas that sit outside the GP8 parity tracker. Nothing here is scheduled.

## Load VST plug-ins on a track (requested 2026-10-30)

Slice 1 (spikes) and Slice 2 (first shippable slice for Windows x64, VST3) are complete under Linear THE-71. See the design specification in `docs/superpowers/specs/2026-11-07-vst-hosting-design.md` and the validation report in `docs/validation/2026-11-08-vst-hosting.md`.

Remaining slices open for future development:
- **Slice 3: Folder scanning.** Scanning the standard VST3 folders, with a per-file probe timeout, a persistent cache, and a blocklist.
- **Slice 4: macOS and Linux helpers.** macOS out-of-process helper (NSWindow, library-validation entitlement, notarisation) and Linux helper (X11 and `IRunLoop`).
- **Slice 5: CLAP hosting.** CLAP support through `clack-host`, using the same helper IPC protocol.
- **Slice 6: Extended features.** Macro knobs and parameter automation, `.vstpreset` exchange, A/B auditioning against the built-in tone, Line-In live monitoring through a plug-in, shared helpers, multiple plug-in slots per track, and track freeze to audio.
