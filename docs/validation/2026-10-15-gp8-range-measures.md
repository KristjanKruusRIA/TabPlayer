# Range and global measure editing validation

Date: 2026-10-15. Branch: `feat/gp8-parity`; released `main` remains `7fc41c7`. This delivery advances the full GP8 parity goal; it does not close the historical 258-requirement inventory.

## Delivered behavior

Editing selections support written half-open tick ranges, explicit chord-note members and complete bars across tracks. Mouse click/Shift/Ctrl-or-Cmd, reverse dragging, endpoint handles, triple-click, Ctrl-or-Cmd+A, Escape and Shift+arrows share one transient selection. Text controls keep their shortcuts. Clicking notation returns keyboard focus to music. Editing selection does not seek or change the practice loop.

Five finite history commands erase, transpose, move to the adjacent sounding string, re-finger or set let-ring/palm-mute on selected strings. The pure chord solver supports 1–12 strings, capo/transposition and harmonic pitch, with fixed unselected notes and deterministic assignments. Changes reject atomically when their pitch, string, relationship or scope constraints cannot be met.

Global insert-before/after and inclusive removal preserve staff/voice alignment, inherited meter/key/clef, surviving links, fractional mix events, raw lyric offsets, line breaks and backing anchors. Cursor position follows surviving music. Removal restores effective suffix tempo/program/bank/volume/pan and stored sustain markers. Native projects keep schema2/engine1.8.4 and immutable original bytes; each operation is one history entry.

## Verification

- Full frontend: **813 Vitest tests pass across75files**, one explicit benchmark skip; **10 Node tests pass**. `npm run typecheck` passes.
- Full Rust1.88 suite: **127 pass**, six explicit hardware/resource ignores. Native strict DTO tests and all **58** shared protocol examples pass; `cargo fmt --check` passes.
- Private17-score corpus runs in the full frontend suite with unchanged source hashes. Imported-GP replay tests preserve raw hidden CRLF lyrics, an archive sibling, embedded binary bytes and original source hash through range transpose, insert/remove, native-style JSON reopen and GP export/reopen.
- Independent reviews cover fingering, range reducers/panel, measures, shared replay/DTOs and UI. Additional oracles cover2,000 exhaustive seeded fingering cases,84 harmonic/capo MIDI cases, and160 mixed histories/2,880 operations comparing settings fast replay with full rebuild. No remaining material findings in the accepted scope.

Fresh Windows diagnostic build and `tests/desktop/parity-range-measures.mjs` pass using an authored four-track guitar9/bass6/drums/keys GP fixture. Actual interactions verify inspector-to-notation focus, Shift selection, reverse drag, resize handles, triple-click, indexed chord selection, adjacent string moves, keyboard selection, text shortcut exclusion, transpose, pitch/velocity-preserving re-fingering, sustain flags, all-track measure alignment, mapped cursor, undo/redo, native nonzero audio, save, full process restart and reopen. GP output is independently loaded and converted to public MIDI for comparison. Six commands remain in the saved final history after transient undo probes; original GP bytes retain their hash. The app stops cleanly and releases CDP9223.

Ignored receipts: `.analysis/parity/range-frontend-accepted.log`, `range-native.log`, `range-desktop-build-accepted.log`, `range-desktop-accepted.log`, `native-range-measures-result.json` and `native-range-measures.png`. Diagnostic executables and authored/private binary fixtures are not shipping artifacts.

## Review corrections and bounded gaps

Review found and regression-tested empty-lane sustain validation, selection-scope readback, inactive-voice instrument inheritance, and stale renderer range endpoints. Actual Windows reverse dragging exposed browser SVG text dragging; cancelling that default action fixed it. Clicking notation from an inspector input now explicitly restores music keyboard focus. The public renderer reset uses an equal-beat highlight followed by drawing clear, with current-model bounds checked before a nontrivial highlight; playback tick/range remain unchanged.

Program/bank events in inactive voices remain stored but do not become effective state. Missing processed boundary carriers and removed state needed by sounding pre-boundary grace notes reject before mutation. Sustained-pedal markers are retained; audible CC64 support remains open.

The pinned GP reader loses ties beyond a three-bar search distance and forward hammer/linked-slide relationships across an inserted blank bar, although GPIF flags remain present. Insertions that newly create these unsupported gaps reject atomically. Ties at the proven three-bar boundary, unrelated existing long links and explicit slurs remain supported. Explicit GPIF link reconstruction is a later parity task, not a claimed Guitar Pro format restriction.

Contextual simile/repeat/direction restrictions remain visible. Passage-wide fingering optimization, clipboard, continuous controller ramps, full engraving, fermata timing, original GP8 runtime acceptance and physical macOS/Linux verification remain open. No production installer or new `main` release is produced by this batch.
