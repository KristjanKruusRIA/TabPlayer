# TabPlayer deferred-feature expansion

Date: 2026-10-14. Status: approved by the user. Subsequent scope design and plan reviews are auto-approved under the updated goal.

## Intended result

Complete all product features explicitly deferred by the initial player/editor design and execution rulings. TabPlayer remains a local, offline desktop application for Windows, macOS and Linux, built with Rust/Tauri and alphaTab 1.8.4. The user approved native Rust audio and selected an independent realistic guitar/bass engine with articulations, amps and effects comparable in capability to RSE. Existing projects, original imported files, undo/redo and the approved editor layout remain usable.

The expansion has three sub-projects. Each gets a specification and implementation plan and produces testable software. Finishing one does not finish the overall goal. Implementation remains in this chat, followed by an independent review of the complete change.

## Complete scope and evidence

| Requirement | Owning specification | Evidence required for completion |
| --- | --- | --- |
| E1 Advanced technique creation/editing, including breaking imported ties | [Advanced editor](2026-10-14-tabplayer-advanced-editor-design.md) | Authored and imported technique fixtures; rendered symbols, generated pitches/timing, history/reopen and export coverage |
| E2 Detailed voice/staff layouts | Advanced editor | Multi-voice/staff creation, copy/removal, timing, selection and replay tests |
| E3 Additional notation and rhythm controls | Advanced editor | Tuplet/grace, meter/key/clef, repeat/ending/tempo and text/chord fixture coverage |
| E4 Existing-track rename and instrument changes | Advanced editor | Existing imported/new track changes survive undo, redo, save and restart and affect playback |
| E5 Fractional selection input bug | Advanced editor | Fractional, empty and non-finite input cannot throw or install an invalid selection |
| A1 Synchronized backing audio | [Native audio](2026-10-14-tabplayer-native-audio-design.md) | Import/embedded extraction, mixed playback, anchors, seek/loop/speed, history and self-contained reopen |
| A2 Independent realistic guitar/bass engine | Native audio | Recorded-sample voices, articulation and polyphonic pitch tests plus user listening acceptance |
| A3 Per-track amps and effects | Native audio | Audible presets, bypass/parameter tests, persistence and parity between live/offline processing |
| X1 Printing and PDF export | [Exports](2026-10-14-tabplayer-exports-design.md) | Printable paginated PDF, verified pages/fonts/symbols and native print flow |
| X2 MIDI export | Exports | Independent MIDI parsing confirms tempo, track/program, rhythm and technique events |
| X3 Mixed audio and stem export | Exports | Independent WAV decoding confirms content, mix/effects, backing, duration and alignment |
| C1 Preserve initial milestone behavior | All three | Existing meaningful tests plus native open/edit/play/save/restart/reopen regression |
| C2 Offline packaged application | All three | Bundled assets/license inventory and network-disabled packaged tests |
| C3 Desktop platform support | Exports | Windows/macOS/Linux builds and native platform smoke evidence, with actual audio evidence identified separately |

## Shared contracts and preservation

Rust continues to own document history and file writes. TypeScript continues to validate candidate score edits through public alphaTab model APIs. Extend the finite command protocol; do not persist alphaTab model JSON. Split the score edit adapter by responsibility only where the new command families require it.

Native project schema version 2 retains the immutable base and ordered edits and adds an immutable, content-addressed asset table. Asset keys are SHA-256 digests; records hold filename, media type and base64 bytes. Commands reference those digests. Version 1 projects migrate in memory without changing their musical result and save as version 2. Engine version remains exactly 1.8.4. Validate hashes, asset references, command shape and musical constraints before replacing a live document. Adding an asset and its referencing command is one transaction. Failed transactions change neither history nor dirty state. Undo retains assets needed by redo; a saved copy may omit assets unreferenced by its applied commands without mutating the live session.

Large audio assets stay Rust-side during editing. Routine runtime snapshots expose their digest/metadata rather than retransmitting encoded audio after every edit. Disk persistence still contains complete encoded asset records, so reopening needs no original backing-file path. Built-in instrument packs are versioned application resources, not duplicated in each project.

Score edits, backing selection/synchronization, sound configuration and print layout are undoable and saved. Transport position, the current selection, zoom and temporary export settings remain session state. Track sound/mixer configuration uses the existing stable track identities; removing a track and undoing restores its configuration. Opening a different document resets session state to that document. Structural commands maintain relationships and all track/staff/bar alignments, including synchronization anchors.

Native Rust owns audio rendering and its sample clock. The webview sends prepared score events and configuration, and receives transport state; it does not stream PCM over Tauri. alphaTab remains the notation/MIDI generator and its public external-media interface drives the cursor from the Rust clock. Live and offline rendering use the same Rust musical voices and effects. Export operates on an immutable document snapshot and cannot mark an unsaved project clean.

All score, asset and export I/O retains source-overwrite protection and atomic replacement. Export cancellation/failure preserves previous output files. Large asset reads, decoding and exports run away from the UI and audio callback. Shipping builds omit the existing desktop test commands. Dependency versions and notices are recorded, and bundled sample sources are pinned and hashed. Private test music and Guitar Pro program files and resources remain outside product/source releases.

## Completion and release records

Feature completion requires E1–E5, A1–A3 and X1–X3 plus their applicable preservation/offline/platform checks. Every acceptance check receives a result and evidence path in the validation report; a passing narrow test does not establish an entire feature. The sound target requires a listening review of clean guitar, distorted guitar and bass passages with contrasting articulations, not just proof of nonzero PCM.

Keep the earlier release checklist visible: original Guitar Pro acceptance of exported files; installer installation/uninstallation; platform-native playback; and signing. Build and test installers as part of delivery. Record any unavailable Guitar Pro runtime or signing identity explicitly rather than claiming it verified. Signing is a release credential requirement, not an additional editor/audio feature. The previously rejected generated-workspace cleanup remains recorded; it is not retried through another tool. The synchronous notation workaround stays until evidence shows a safe worker-rendering fix is needed and verified.

The original first-milestone specifications remain historical. These specifications govern the expansion and do not claim that any expansion code already exists.

## Source of scope

- [Approved initial design](2026-10-14-tabplayer-design.md)
- [Execution rulings and deferred minor](../../validation/2026-10-14-tabplayer-rulings.md)
- [Initial validation](../../validation/2026-10-14-tabplayer-milestone.md)
