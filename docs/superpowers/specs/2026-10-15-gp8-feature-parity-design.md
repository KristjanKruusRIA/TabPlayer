# Guitar Pro 8 functional parity

Date: 2026-10-15. Status: approved by the user's standing instruction to finish all deferred work without further approval requests, using parallel feature workers.

## Outcome and reference

TabPlayer remains a Rust/Tauri desktop application for Windows, macOS and Linux, using the approved slate/cream/lime editor layout and alphaTab 1.8.4 where its public API is sufficient. The target is the functional capabilities of the supplied Guitar Pro 8.1.5 installer. The official Guitar Pro 8 user guide supplies the requirement inventory; observations from native files and executable probes distinguish supported behavior from assumptions. This does not require copying proprietary code, graphics, samples, credentials, or commercial song catalogs.

The released 0.2.0 implementation is the starting point, not evidence of full parity. The baseline audit in `docs/validation/2026-10-15-gp8-parity-baseline.md` and its machine-readable counterpart tracks each requirement as implemented, partial, missing or unverified. Passing a parser, serialization or unit test alone does not establish a working user workflow or Guitar Pro compatibility. Unknown runtime behavior stays unverified.

Reference: https://static.guitar-pro.com/gp8/manual/Guitar-Pro-8-user-guide.pdf . Supporting official pages and their retrieval evidence are retained locally in `.analysis/parity/public-manual-pages.json`.

## Scope and sequence

The full inventory remains open across these deliverable families:

1. Entry and notation: stringed, pitched and percussion instruments; voices/staves, rhythm, articulations, directions, fermatas, tuplets, per-note playback controls and editing assistants.
2. Song presentation: full metadata, lyrics, stylesheet, notation visibility, score layout and printing.
3. Editing workflows: selection, range clipboard, paste special, structural edits and reversible history.
4. Instrument and theory tools: tuning/string-count/refingering, partial capo, chords, scales, transpose, interactive instrument views and handedness.
5. Playback and performance: repeat/direction behavior, progressive practice, MIDI input/output/capture, tuner, Line-In and supported external-device workflows.
6. Sound: independent realistic instruments/articulations, sound and volume/pan automation, amp/effect breadth and per-note timing/velocity.
7. Backing audio: synchronization, waveform editing, pitch/time handling and native transport integration.
8. Interchange: all documented import/export formats and batch operations, including MusicXML and precise GPIF compatibility.
9. Workspace: document/library management, preferences, command palette and offline desktop distribution.

Each family needs its own bounded implementation plan as evidence resolves the contracts. Do not replace the inventory with a smaller easy-feature list. Service-owned catalogs and proprietary hardware require equivalent supported integration or an explicit unverified dependency, rather than a false completion claim.

## First parallel delivery: entry, song data, and interchange

### Song data and directions

Add `setScoreMetadata` with a `fields` object containing eight required string fields: `subTitle`, `album`, `words`, `music`, `copyright`, `tab`, `notices`, `instructions`. Existing title/artist/tempo editing remains compatible. Add `setDirections {bar, directions:number[]}` for the 19 public `model.Direction` values. Replace the bar's direction set, normalize duplicates and reject invalid values. Add `setNoteSpelling {target, noteIndex, accidentalMode}` using all seven public accidental modes (Default plus six forced modes). Preserve the sounding pitch. These operations must survive native history replay and supported GP roundtrip.

The metadata, direction and spelling panels follow the existing selected beat and form patterns. The known pickup/D.C. playback difference remains open until corrected and tested; setting a direction alone does not close it.

### Pitched and percussion entry

Add the following finite history commands, with zero-based `noteIndex` and existing `BeatTarget`:

- `addPitchedTrack {name, program}` and `addPercussionTrack {name, program}`.
- `addPitchedNote {target, pitch}` and `setPitchedNote {target, noteIndex, pitch}`. Pitch is the written MIDI pitch, integer 0–127; staff transposition determines the sounding pitch.
- `addPercussionNote {target, articulation}` and `setPercussionNote {target, noteIndex, articulation}`. Articulation is a valid public standard ID or valid track-specific articulation index, not assumed equal to MIDI pitch.
- `removeNoteByIndex {target, noteIndex}`.
- `setNoteTechniquesByIndex {target, noteIndex, patch}`.
- `setNoteLinkByIndex {from:{target,noteIndex}, to:null|{target,noteIndex}, kind}`.

Non-tab notes use public model `string=-1,fret=-1`. Pitched note octave/tone derive from written MIDI (`60` gives model octave `5`, tone `0`). Drum tracks use channel 9 and the public articulation output-pitch mapping. New pitched tracks allocate distinct logical channels, skipping 9, without imposing the SMF export's 15-melodic-channel cap on the editor. Generic techniques resolve the chosen note by index; string-only techniques reject unsupported targets. Existing string-addressed commands and native project versions retain their meaning.

Add a focused non-tab panel with note-name pitch input and named drum articulation selection. Stable note selection must follow score clicks. Empty tuning is valid for non-tab pitched/percussion staves. Changes must preserve ties/slurs and score capacity validation. Native engine and independently decoded MIDI output establish the actual pitches/channel, not just displayed labels.

### GP track automation adapter and MusicXML entry

Use public `fflate` 0.8.3 plus DOM XML APIs in an owned adapter, without patching dependencies. `loadInterchangeScore(bytes, settings)` wraps public ScoreLoader. `exportGpInterchange(score, settings)` wraps public GP7 exporter. Restore/write real GPIF track channel strip automations: `DSPParam_11` pan and `DSPParam_12` volume. Map GPIF track IDs via `MasterTrack/Tracks`, preserve fractional bar positions, linear flags, visible/text fields, sibling archive entries and source immutability. Native scalar 0–1 maps to model units 0–16.

MIDI generation must schedule these events at their actual performed positions, including repeated bars, for live playback and SMF export. Remove only these automation objects from a detached generator model, preserving initial controller and fade/swell events. A linear flag roundtrip is insufficient evidence of audible continuous ramps. Master volume/pan remains a distinct requirement.

Expose `.xml`, `.musicxml` and `.mxl` intake through existing public MusicXML importer and desktop filters. Keep independently reproduced importer defects (tempo offsets, natural harmonic, volume/pan directions) open until their semantics are fixed with fixtures. GP compatibility must use standard GPIF fields, never private extension fields presented as native parity.

Desktop validation also reproduced loss of pitched staff sounding transposition on GP export. For a non-tab pitched staff, an owned detached export model may bake sounding transposition into note pitches, reset that transient sounding offset and retain display transposition. Both sounding and displayed pitches must remain identical, including ties, chords and supported trills. Native project history retains its original settings. This translates to native GPIF note pitches; it does not claim persistence of an alphaTab-specific internal setting. Stringed transposition/fret normalization remains a separate open compatibility requirement.

### Shared correctness

Fix loss of per-note dynamics during score rebuild. A command asking for dynamics 3 must still yield 3 after rebuild, subsequent edits, save/reopen and native playback generation. This is distinct from Guitar Pro's per-note relative velocity in dB, which remains an additional requirement. Preserve model links/caches using owned conversion code where necessary; do not modify installed alphaTab files.

## Architecture and ownership

The root integrator owns shared TypeScript command/schema validation, Rust serde DTOs, engine/router, App, EditorPanel, ScoreView, dependencies, Git operations and desktop testing. Feature workers own isolated new modules/panels/tests. The non-tab worker additionally owns `common.ts`, `techniques.ts`, and `TechniquePanel.tsx`. The interchange worker owns new `src/interchange` modules. Each worker supplies evidence and a narrow handoff; no worker starts an app, changes shared schemas, commits, pushes or touches another worker's files.

Source bytes and history remain immutable. Rebuild/replay must reproduce edits deterministically, including undo/redo and export. Private song files and vendor files remain ignored local evidence. No keys, licensed banks or private songs enter the repository.

## Acceptance

For each delivery: meaningful failing tests before implementation; focused tests and typecheck; shared frontend/native schema fixtures; native history replay, undo/redo and file roundtrip; independent review of immutable changes; visual/desktop verification for affected flows. Broader frontend/native checks run after integration. Cross-platform packaging and physical/audio limitations are stated accurately. The complete goal closes only when the full requirement matrix has evidence for each workflow, with unresolved external dependencies reported explicitly.
