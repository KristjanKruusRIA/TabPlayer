# UI redesign phases 1 and 2: shared controls, the Sound rig and the instrument views (2026-10-30)

This records the first two phases of `docs/superpowers/specs/2026-10-30-ui-redesign-design.md` and the work after them: drawn instruments in the Sound view and on the score's instrument dock. Phases 3 to 6 (shell, mixer, editing toolbar, dialogs) are not started. The work is partial in the ways listed under Limits.

## What changed
- **Fonts and tokens:** Instrument Sans and IBM Plex Mono come from `@fontsource` packages (Latin subsets, OFL) and are bundled by Vite. Colour and radius tokens are `--tp-*` custom properties in `src/ui/ui.css`; the shell's own `--ws-*` tokens are untouched until phase 3.
- **Controls (`src/ui`):** Knob, Fader, Segmented and Dialog. A drag or a run of wheel ticks commits one value, so a host records one undo step for the gesture; a typed value and each arrow press are their own change. Knob and Fader take typed values the same way.
- **Sound rig (`src/rig`):** a chain of all 18 blocks, an amp with tolex, piping, grille weave and a brushed plate in a colour per model, a coloured face for every block, a cabinet with the microphone's four placements as spots and a drawn microphone, ten graphic EQ faders and a searchable sound browser with Hear on every row. A drag is heard while it moves through `previewSound` (at most every 70 ms) and records one edit on release.
- **Instrument picker:** the Track and Sound source dropdowns are a strip of tracks and a radio group of sources, each drawn: green and black guitar, darkblack and babyblue bass, a keyboard for General MIDI, and Automatic, which says what it plays as. Automatic follows the track's General MIDI program, as `automatic_voice_id` in `voices.rs` does (`automaticVoice` mirrors it and has a test). Choosing is the same one `setTrackSound` edit; Hear previews a source without recording.
- **Instrument views:** the neck has a headstock, nut, pearl inlays and wound low strings graded by string; the keys have a felt strip, lips and gloss; the kit has a pearl wrap, hoops and lathed cymbals. The hardware is one memoised component per instrument with no SVG filter; playback redraws only the lit notes, entry targets and labels.
- **Shell:** a Score and Sound switch in the title bar. Sound covers the workspace; the transport stays above it. The inspector's Sound panel stays in the Score view and is not mounted in the Sound view, so two surfaces never edit one sound at once. From the Sound view, cut, paste, select all, Escape and the command palette do not reach the hidden score; document commands and Space still work.
- **Native:** `audio_set_mix` decodes the backing asset only when the backing changes (`runtime.rs`). This is native code and needs its own hot-path review.
- **Shared logic:** `SoundPanel` and the rig both use `useSoundEditing`. `src-tauri/src/audio/tone.rs` and the audio callback are untouched.

## Review fixes
The hot-path review of the first two commits found, and these commits fixed, each with a test that fails on the previous code:
- a typed `-6.5` became `5` because the field reselected its text on every render;
- a drag survived a track or board change and recorded on the new target;
- a lost pointer capture, a window blur or a mouse move with no button left a preview stuck and the knob following the hover;
- the wheel kept the range of the first field a knob showed;
- a press and release in place recorded an edit on an off-step value, and an arrow key during a drag added a second edit;
- a live preview still in flight at a track change could send one track's sound to another;
- Ctrl+X and Ctrl+V edited the hidden score from the Sound view;
- every knob change decoded the whole backing asset.

The rule for a pointer gesture: it records only when its release is seen with the pointer still held; losing the pointer any other way, or the control going away, ends it with nothing recorded.

## Evidence
- **Typecheck:** `npm run typecheck` was clean.
- **Vitest:** the suite excluding `src/editor/corpus.test.ts` passed at a 60-second timeout: 260 files and 4099 tests with 2 skipped, on the final source.
- **Rust:** `cargo test --lib document_audio_ownership` passed (8 tests). With a 32 MB backing in a debug build, 20 `set_mix` calls with an unchanged backing took 4.3 to 4.5 s and 20 asset decodes before the fix, and 105 microseconds and none after.
- **Real app:** the desktop-test build (`scripts/build-desktop-test.ps1`) was launched with `TABPLAYER_DESKTOP_TEST=1` and driven over CDP on port 9223. With the score playing, a 40-move knob drag on Amp Gain made 19 to 27 `audio_set_mix` calls and no `audio_prepare` (the prepare count stayed 2 across the drag), one `apply_edit` on release, and the transport time kept advancing (0:02 to 0:05 of 0:08) with playback still on. This counts native calls and transport time; nobody listened for clicks or dropouts, which still needs an ear.
- **Real app, screenshots:** the picker and each instrument view with notes lit, at 1440 by 900 and 960 by 600. Driving the real app found a bug the browser harness had not: in entry mode every piano key drew black because the entry props replaced the keys' class. It is fixed and has a test.
- **Cached layer:** a test keeps the same DOM nodes for the hardware across five changes of lit notes for the neck, keys and kit, and another asserts no SVG filter in any of them. In a browser, 300 lit-note updates cost 0.8 ms each with the hardware kept and 3.5 to 4.7 ms each when it was rebuilt every time.
- **Build:** `vite build` emitted the font files into the bundle.

## Limits
- **Listening:** no sound was played or heard. Click, zipper noise or dropout from a drag is not measured.
- **Instrument dock:** the dock is short by default and shows only the top of an instrument; the screenshots enlarge it with `--dock-height` to show the whole drawing.
- **Wheel:** the wheel turns a knob only while it has focus.
- **Space:** Space on a focused knob or fader reaches the shell and plays or pauses. On a chain tab it switches the pedal.
- **Drag reordering** uses pointer events, not HTML drag and drop, because Tauri's file-drop handling can take over native drag and drop. It was tested with synthetic pointer events only.
- **Sources drawn:** one drawing per source, a generic electric guitar or bass in the colour its name gives, and a keyboard for General MIDI. Nothing claims a model of instrument. The cabinet shows one speaker for every model because the engine does not say more.
- **Left in the inspector panel:** nothing was removed from `SoundPanel`; the rig covers every function it has (see the rig tests).
- **Cabinet response and master panel:** only empty slots exist (`data-slot="cabinet-response"`, `data-slot="master"`).
- **Native change:** the `set_mix` change skips the asset check when the backing is unchanged, so an unreadable asset is reported when the backing changes rather than on every mix change.
