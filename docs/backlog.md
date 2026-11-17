# Backlog

Product ideas that sit outside the GP8 parity tracker. Nothing here is scheduled.

## Load VST plug-ins on a track (requested 2026-10-30)

Slice 1 (spikes) and Slice 2 (first shippable slice for Windows x64, VST3) are complete under Linear THE-71. See the design specification in `docs/superpowers/specs/2026-11-07-vst-hosting-design.md` and the validation report in `docs/validation/2026-11-08-vst-hosting.md`.

**Instrument hosting is done for Windows (THE-218, 2026-11-17).** A drum track can hold a VST3 instrument, which plays the track from the score's notes; see `docs/validation/2026-11-17-vst-instruments.md`. Still open from it:
- **Drum maps are done (THE-219, 2026-11-17).** A drum track carries a map (a layout plus changed rows) that decides the keys of its hosted instrument and its MIDI port, with an editor, file import and export, and five library layouts; see `docs/validation/2026-11-17-drum-maps.md`. Still open from it:
  - **Owner verification of the presets.** The five layouts are unverified third-party numbers; the owner's own exported layouts are the reference.
  - **Audition.** A single sound cannot be played from the editor (no hit path, no stopped-transport listening window).
  - **Hi-hat openness (CC4) and choke modes.** Need a new map file format version (version 2), since `[id, key]` rows cannot carry them.
  - **Presets for other libraries,** from map files the owner exports.
  - **Translated percussion names** in the key editor (English in every language today).
  - **An app-wide map library** (maps live in the project today).
  - **Maps applied to exported MIDI** (and Guitar Pro) files.
  - **The MIDI out late note-off guard:** a late note-off for a note that was never sent can end another strike of the same key early (fixed for hosted instruments only).
  - **The worktree build script:** `scripts/build-desktop-test.ps1` fails where `src-tauri/resources/library` is a junction.
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

## Drum tablature (THE-220, done 2026-11-17)

A drum track can show its hits as a six-line tab of the written sound numbers, instead of or beside the percussion staff; see `docs/validation/2026-11-17-drum-tablature.md`. It is stored as the track's engraving profile, so no project-schema field was added. Still open from it:
- **Digit entry on the tab.** Hits are entered from the drum kit; a number cannot be typed on the tab staff.
- **Guitar Pro's per-note drum-tab lines.** The importers of alphaTab 1.8.4 drop them, so a fixed rule (cymbals, ride and metal, hi-hat, toms, snare, kick) decides the line. alphaTab 1.9 draws drum tab natively; the upgrade is a separate project and would replace this work.
- **Guitar Pro export of the preference.** The tab/standard choice lives in the engraving profile and is not written to a `.gp` file.
- **Smaller review findings** (error shading on both staves, arrow keys by drawn line, a print test that checks lines, a measurement of re-projection on a long score); listed in `docs/validation/2026-11-17-the-220-drum-tab.md`.
