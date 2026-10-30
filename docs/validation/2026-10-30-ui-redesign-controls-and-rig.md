# UI redesign phases 1 and 2: shared controls and the Sound rig (2026-10-30)

This records the first two phases of `docs/superpowers/specs/2026-10-30-ui-redesign-design.md`: the control foundation and the Sound rig. Phases 3 to 6 (shell, mixer, editing toolbar, dialogs) are not started. The work is partial in the ways listed under Limits.

## What changed
- **Fonts and tokens:** Instrument Sans and IBM Plex Mono come from `@fontsource` packages (Latin subsets, OFL) and are bundled by Vite, so the interface does not need the network. Colour and radius tokens are `--tp-*` custom properties in `src/ui/ui.css`. The shell's own `--ws-*` tokens are untouched until phase 3.
- **Controls (`src/ui`):** Knob, Fader, Segmented and Dialog. A drag, a run of wheel ticks or a typed value commits one value, so a host records one undo step for the gesture.
- **Sound rig (`src/rig`):** a chain of all 18 blocks, an SVG amp faceplate, SVG pedal faces, a cabinet with the microphone's four placements as spots, ten graphic EQ faders and a searchable sound browser with Hear on every row.
- **Shell:** a Score and Sound switch in the title bar. Sound covers the whole workspace; the transport stays above it. The inspector's Sound panel is still there in the Score view and is not mounted in the Sound view, so two surfaces never edit one sound at once.
- **Shared logic:** `SoundPanel` and the rig both use `useSoundEditing`. Every edit is one `setTrackSound` edit. Audio code, including `src-tauri/src/audio/tone.rs`, is untouched.

## Evidence
- **Typecheck:** `npm run typecheck` was clean.
- **Vitest:** the whole suite excluding `src/editor/corpus.test.ts` passed: 253 files and 4017 tests, with 2 skipped, at a 60-second timeout. The new tests are 13 for Knob, 10 for the other controls, 36 for the rig and 1 in `src/App.test.tsx`.
- **Rendering:** the rig was rendered with Vite and a Playwright browser at 1440 by 900 and 960 by 600, inside a stand-in shell with a title bar, a document tab strip and a transport 85 px high (the largest the real transport is expected to take). Faces and layouts were corrected from those screenshots. At 960 by 600 the sound browser collapses to a drawer opened by a Sounds button, and the stage keeps its full width.
- **Build:** `vite build` emitted the font files into the bundle.

## Limits
- **Not the real app:** the screenshots come from the stand-in shell, because the full app needs the Tauri host. The real shell, the real transport height and the title bar's Score and Sound switch were exercised only in jsdom (`src/App.test.tsx`), not seen. No `tests/desktop` driver was run and the desktop build was not made.
- **No live audition of a drag:** a knob shows its value while it moves but the audio changes when it is released, because one undo step per drag was required and the engine has no non-recording live path.
- **Wheel:** the wheel turns a knob only while it has focus, so scrolling past a control never changes it.
- **Space:** Space on a focused knob or fader reaches the shell and plays or pauses, as it does elsewhere. On a chain tab it switches the pedal.
- **Drag reordering** uses pointer events, not HTML drag and drop, because Tauri's file-drop handling can take over native drag and drop. It was tested with synthetic pointer events only.
- **Left in the inspector panel:** nothing was removed from `SoundPanel`; the rig covers every function it has (see the rig tests). The panel stays until the parity is checked on a desktop build.
- **Cabinet response and master panel:** only empty slots exist (`data-slot="cabinet-response"`, `data-slot="master"`) for `CabinetResponse.tsx` and `MasterPanel.tsx` from other branches. Neither is wired.
