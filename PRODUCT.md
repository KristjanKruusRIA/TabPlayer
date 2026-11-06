# TabPlayer

<!-- impeccable:product-schema 1 -->

## Platform

web

The interface uses React and TypeScript inside a Rust/Tauri desktop application. Windows, macOS and Linux are the target desktop platforms. The web UI depends on native commands for documents, playback and file operations; it is not a standalone browser application. Mobile is not an established target.

## Users

Guitar and bass players learning and practising songs are the primary audience, confirmed by the user on 2026-10-15. Composition and detailed score editing support that audience's practice workflow.

## Product Purpose

Help musicians open tablature, understand what to play, practise passages and adapt scores to their needs in a local desktop application.

The user's leading product priority is a **comfortable UI**. Future interface decisions should make learning and practising comfortable while keeping the existing editing and playback capabilities usable.

Success means a player can open a score, find the relevant part, hear and repeat it, make useful edits and reliably save their work.

## Positioning

TabPlayer is an independent desktop tablature player and editor. It combines Guitar Pro imports, editable multi-track notation, native recorded guitar/bass playback and local projects that retain the original score alongside edits.

These are established product characteristics, not evidence of market uniqueness. Full Guitar Pro feature parity and lossless interchange are not established claims.

## Operating Context

- Open `.gp`, `.gpx`, `.gp3`, `.gp4`, `.gp5` or native `.tabplayer` files; select a track and study its score, tablature or both.
- Practise with speed control, seeking, inclusive measure loops, a metronome and track mixing. Optional guitar, bass, drum and keyboard views follow the selected track's playback.
- Edit notes, techniques, rhythms, measures, tracks, staves and voices. Use tuning presets or custom tuning for the player's instrument.
- Use backing recordings and sound controls when needed; save a native project to retain supported edits and embedded backing audio.
- Export GP, PDF/print, MIDI, mixed WAV or WAV stems as separate delivery actions.
- The score workflow runs locally without an account or cloud backend. Shipping assets support offline use; first-time development resource preparation can download pinned public inputs.

## Capabilities and Constraints

- Rust owns document history, persistence, audio rendering and exports. React and alphaTab provide the interface, notation and score/MIDI preparation. Native playback is the timing authority for score and instrument highlights.
- Original imported score bytes remain in the native project. Native saving and interchange export are distinct; original score and backing sources are protected from replacement.
- Failed imports, edits, history operations and writes must preserve the current work. Unsaved work requires Save/Discard/Cancel when replacing a document or closing the window.
- Document edits and persisted settings support undo/redo. Selection, screen zoom, transport position, practice speed and loops are session controls.
- Tuning, capo and transposition are separate concepts. The recorded sound override is separate from a track's MIDI instrument. Keep these distinctions clear in controls and copy.
- GP export can omit supported native details; users should retain the native project. Do not imply an export preserves everything or has passed original Guitar Pro runtime acceptance.
- The existing desktop shell has a 960 by 600 minimum window size. Keyboard and pointer operation are established interaction requirements.
- Current release capabilities and verification limits come from this checkout's README and validation records. Work recorded only on other branches is not a shipped capability.

## Brand Commitments

The product name is **TabPlayer**. It is an independent application, with app-owned artwork and explicitly licensed third-party resources. Guitar Pro application assets and private test scores are excluded from distribution. No additional brand voice or identity mandate was established during init.

## Evidence on Hand

- [README.md](README.md): current capabilities, workflows, development commands and documented limitations.
- [Approved product design](docs/superpowers/specs/2026-10-14-tabplayer-design.md): original product intent and preservation requirements. Later expansion records supersede its first-milestone scope and original playback architecture.
- [Approved advanced editor design](docs/superpowers/specs/2026-10-14-tabplayer-advanced-editor-design.md): editing terminology, keyboard access and safe interaction requirements.
- [Expansion validation](docs/validation/2026-10-14-tabplayer-expansion.md) and [tuning/instrument-view validation](docs/validation/2026-10-15-tunings-and-instrument-views.md): implemented features and dated verification evidence. Windows installed offline use is recorded; physical macOS/Linux playback, print and installation remain unverified.
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [audio provenance](assets/audio/README.md) and `src-tauri/icons/`: existing distributable assets and source boundaries.

Pricing, a business model, formal user research and market differentiation remain undecided. Do not invent testimonials, customer counts or compatibility claims.

## Product Principles

1. Put a comfortable learning and practice experience first.
2. Keep musical context clear across score, playback, selection and instrument views.
3. Preserve the player's work and original files; make changes understandable and undoable.
4. Keep the core score workflow local and usable offline.
5. State compatibility and export limits accurately.

## Accessibility & Inclusion

Controls require accessible names and keyboard operation. Preserve score navigation and fret entry from the keyboard, visible focus and clear explanations for invalid actions. Rejected input must not discard work or selection. No formal accessibility conformance standard or additional audience-specific requirement was established during init.
