# GP8 parity S03 slice 1: move track (2026-10-22)

GP8 (manual pp.67–69) lets users reorder, duplicate and recolor tracks. This slice adds reordering as the replayed edit command `moveTrack {track, to}`. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Engine (`src/engine.ts`):**
  - `moveTrack` moves the track at `track` to position `to`. Both must be existing positions and must differ.
  - The track keeps its notes, voices, staves, lyrics, chords, line breaks, automations, MIDI channels and percussion articulations.
  - The stylesheet's per-track maps are remapped with the same permutation.
  - The document's track identities are permuted the same way, so per-track sound, mix, engraving profile and track-view settings stay with the moved track. That holds on the full rebuild, the settings fast path and settings Undo/Redo.
  - Later index-based edits address the new positions. Undo replays the shorter history.
- **GP export (`src/interchange/gp.ts`):** after any track-structure edit (add, remove or move a track), the source archive's track-ordered entries are dropped so they cannot describe the wrong tracks: `Content/PartConfiguration`, `Content/LayoutConfiguration` and `Content/ScoreViews/*`. alphaTab regenerates the first two from the current tracks. Other edits keep the source entries.
- **Validation:**
  - The command envelope is checked in TS. `to` must be an integer, and a move to the same place is refused on both sides.
  - Rust `EditCommand::MoveTrack` is added, with the shared protocol example 69.
  - Library metadata reorders `trackNames` in both TS and the Rust streaming reader, which refuses a missing, negative, fractional or repeated `to`.
- **UI:**
  - Track settings has Move track up and Move track down, disabled at the ends.
  - After a move the selection follows the moved track.
  - Undo and Redo keep the selection on the same track by its identity.

## Evidence
- **Frontend:**
  - `engine.test.ts`, "moving tracks":
    - order, notes and channels;
    - identity order on rebuild;
    - a mix keyed by identity, plus a later mix through the fast path landing on the moved track;
    - moving back;
    - stylesheet multi-rest remap through a GP round trip;
    - lyrics and a later `setNote` at the new index, with Undo equal to the shorter history;
    - refusal of same or out-of-range positions;
    - archive entries dropped after move, add and remove, kept after a note edit, with PartConfiguration and LayoutConfiguration equal to alphaTab's regenerated copies.
  - Metadata projection (TS) with a move in the canonical sequence and refused moves.
  - `selection.test.ts`: `movedTrackIndex` and `followSelectedTrack` (Undo, Redo, unmoved and removed tracks).
  - `TrackSettingsPanel.test.tsx`: the buttons, their payloads and the disabled ends.
  - Each fix the review asked for has a test. Reverting the metadata `to` field bit fails its Rust test.
- **Native:**
  - `tests/protocol.rs`: 69 round-tripping examples, plus a test that refuses a move to the same, missing, fractional or negative position.
  - `file_library_metadata.rs` and `file_library_types.rs`: the move in the projected sequence, refused malformed moves and a repeated `to`.
  - `cargo test --lib` passes.
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-move-track.mjs` opens the four-track fixture, selects Bass6 and presses Move track up. It asserts:
  - the recorded edit;
  - the Mixer track order `Bass6, Guitar9`;
  - that the panel still shows Bass6 and can't move further up;
  - that a GP export reloads as `Bass6, Guitar9, Drums, Keys` with Bass6's notes;
  - that Undo restores the order and keeps Bass6 selected;
  - that there are no page errors.
- **Review:** an Opus adversarial review. Round 1 found the following, all fixed:
  - the selection did not follow Undo/Redo of a move;
  - the fast-path settings test never reached the fast path;
  - no tests covered pruning on add and remove;
  - Rust accepted a move to the same place;
  - test gaps;
  - a misplaced doc comment.

## Limits
- S03 stays partial. Duplicating a track (fresh note and beat IDs, MIDI channels, copied sound and mix) and recoloring tracks are later slices.
- Tracks are reordered with buttons, not by dragging in the track list.
- After a track is added, removed or moved, a GP source's custom score views and its layout settings (zoom, view) reset to defaults on export.
- A separate, pre-existing issue: on a GP source, the original PartConfiguration still overrides staff-visibility edits on re-import when no track-structure edit happened.
- `tests/desktop/parity-clipboard.mjs` currently fails before any editing: the Library welcome dialog blocks its first click. That is a harness gap unrelated to this slice.
- Under a full parallel Vitest run, a few long UI tests (tuning-ui, corpus, WorkspaceApp) can time out. They pass when run alone.
