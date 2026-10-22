# GP8 parity S03 slice 3: track color (2026-10-22)

GP8 (manual pp.67–69) lets users reorder, duplicate and recolor tracks. This slice adds recoloring as the replayed edit command `setTrackColor {track, color}`, where `color` is `#rrggbb`. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Engine (`src/editor/structure.ts`, `src/track-color.ts`):** `setTrackColor` sets the track's color to the given RGB, fully opaque. The color stays with the track when it is moved or duplicated. Undo replays the shorter history.
- **GP export:** alphaTab writes the color to GPIF as `<Color>r g b</Color>` and reads it back. It is not a track-structure edit, so the source archive's entries are kept.
- **Validation:**
  - TS and Rust both accept exactly `#` followed by six hex digits, in either case.
  - Shorter or longer values, other prefixes, whitespace, a trailing newline, non-ASCII text and non-strings are refused.
  - Rust has `EditCommand::SetTrackColor` and shared protocol example 71.
  - Library metadata ignores the edit, since it does not change track names.
- **UI:**
  - Track settings → Selected instrument has a Track color picker and an Apply track color button.
  - The button is disabled while the color is unchanged, so no empty Undo steps are recorded.
  - The picker resets to the selected track's color after a selection change, Undo or Redo.
  - Each Mixer track button shows a decorative color swatch (`aria-hidden`, visible in forced-colors mode). Its accessible name is unchanged.

## Evidence
- **Frontend:**
  - `engine.test.ts`, "recoloring tracks":
    - exact RGB and alpha after applying the color;
    - the color survives a GP round trip and a duplicate;
    - the earlier history is unchanged;
    - refused colors, including 7-character values without `#` and a trailing newline, and a missing track.
  - `TrackSettingsPanel.test.tsx`: picker value, edit payload, reset for another track, and the disabled button when nothing changed.
  - `TrackPanel.test.tsx`: the swatch shows the track color.
  - `harmony-commands.test.ts`: the shared wire examples (71).
  - RED log: `.analysis/parity/track-color-red.log`.
- **Native:** `tests/protocol.rs` round-trips 71 examples and refuses malformed colors, including 7-byte non-ASCII input that would panic if the `#` check were removed. `cargo test --lib` passes.
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-track-color.mjs` opens the four-track fixture, selects Bass6, picks `#ff8800` and applies it. It asserts:
  - the recorded edit;
  - the Mixer swatch is `rgb(255, 136, 0)`;
  - a GP export reloads Bass6 as 255/136/0 while the other tracks keep 200/0/0;
  - Undo restores the original swatch;
  - there are no page errors.
- **Review:** an Opus adversarial review approved the slice with only low findings. These are fixed, with tests: test gaps for 7-byte inputs, the panel reset, no-op applies, and forced-colors visibility.

## Limits
- S03 stays partial. Tracks are reordered with buttons, not by dragging.
- New tracks still start with alphaTab's default red, rather than GP8's per-instrument default colors.
- Color shows in the Mixer track list and is exported to GP. The score view does not tint tracks by color.
- Recoloring clears the music selection, as other track-settings edits do.
- No original-GP8 side-by-side comparison was made.
