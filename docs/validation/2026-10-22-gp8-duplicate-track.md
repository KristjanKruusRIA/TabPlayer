# GP8 parity S03 slice 2: duplicate track (2026-10-22)

GP8 (manual pp.67–69) lets users reorder, duplicate and recolor tracks. This slice adds duplication as the replayed edit command `duplicateTrack {track}`. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Engine (`src/engine.ts`):**
  - `duplicateTrack` inserts a copy of the track right after it. The copy has the same name, instrument, tuning, staves, notes, voices, lyrics source, chord harmony and per-track style.
  - Every bar, voice, beat and note in the copy gets a fresh ID, so a GP export has unique GPIF IDs.
  - Ties, slides and other links whose two ends are both in the source track are copied between the copied notes. The source keeps its own links.
  - A melodic copy takes the next free MIDI channels. When every channel is taken, the copy shares its source's channels, as a GP8 copy does; adding a new track still refuses. Percussion keeps the drum channel.
  - The copy gets a new document identity. The source's sound, mix and engraving profile are copied to it; later changes to either track stay separate on the full rebuild, the settings fast path and settings Undo/Redo, which rebuilds when a duplicate is in the history.
  - The stylesheet's per-track maps gain an entry for the copy and shift later tracks.
- **GP export:** a duplicate is a track-structure edit, so the source archive's `Content/PartConfiguration`, `Content/LayoutConfiguration` and `Content/ScoreViews/*` are dropped and regenerated, as for add, remove and move.
- **Validation:**
  - The TS envelope checks `track`. A missing, negative or fractional track is refused.
  - Rust `EditCommand::DuplicateTrack` is added, with shared protocol example 70.
  - Library metadata inserts the name after the source, in TS and in the Rust streaming reader.
- **UI:** Track settings has a Duplicate track button. After a duplicate the copy is selected; Undo removes it.

## Evidence
- **Frontend:** `engine.test.ts` "duplicating tracks":
  - music, tuning, program, unique IDs, distinct channels, and the drum channel for percussion;
  - shared channels once every channel is taken, while `addTrack` refuses;
  - tie links copied onto the copy only;
  - lyrics, per-track multi-rest style and an identity-keyed mix copied, with later source changes kept off the copy through the fast path and settings replay;
  - the engraving profile copied to the new identity;
  - a GP round trip with unique GPIF Bar, Voice, Beat and Note IDs, and refusal of missing or invalid tracks.
- Also covered: metadata projection (TS), and `TrackSettingsPanel.test.tsx` for the button payload.
- **Mutation checks:** each change below fails its test:
  - removing `copyTrackSettings` (mix and profile);
  - removing the settings-replay fallback;
  - removing the stylesheet duplicate;
  - restoring links before the insert.
- **Native:** `tests/protocol.rs` round-trips 70 examples; `file_library_metadata.rs` and `file_library_types.rs` cover the duplicate in the projected sequence and refuse malformed duplicates; `cargo test --lib` passes.
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-duplicate-track.mjs` opens the four-track fixture, selects Bass6 and presses Duplicate track. It asserts:
  - the recorded edit;
  - the Mixer order `Guitar9, Bass6, Bass6, Drums, Keys`;
  - that the copy is selected;
  - that a GP export reloads both Bass6 tracks with the same notes and tuning, on separate channels;
  - that Undo removes the copy;
  - that there are no page errors.

  Result: `Guitar9@0, Bass6@2, Bass6@6, Drums@9, Keys@4`.
- **Review:** an Opus adversarial review approved the slice. Its low findings were addressed: the track index is passed explicitly, and there are tests for the channel fallback and the profile copy.

## Limits
- S03 stays partial. Track recolor and drag reorder are later slices.
- Undo of a duplicate while the copy is selected leaves the selection on the next track at that position.
- A settings Undo/Redo in a history that contains a duplicate takes the full-build path, so it is slower than the settings fast path.
- After a duplicate, a GP source's custom score views and its layout settings reset to defaults on export.
- No original-GP8 side-by-side comparison was made.
