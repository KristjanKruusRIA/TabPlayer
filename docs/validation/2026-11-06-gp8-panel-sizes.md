# D05 resizable, remembered panels

Date: 2026-11-06. Branch `feature/d05-panel-sizes`, from develop at 7d7857f.

D05 already let the user show and hide the task panes, the inspector and the bottom dock, and the dock's height could be dragged. Two gaps remained: the inspector could not be resized, and no dragged size was kept between runs.

## Behaviour

- **Inspector width:** the inspector's left edge is a drag handle, like the dock's top edge.
  - Drag it, or focus it and use Left and Right (16 px a step), Home and End.
  - Double-click or Escape returns the inspector to its automatic width: 304 px, or 264 px below 1180 px.
  - The width stays between 240 px and 560 px, and the score keeps at least 480 px. At the 960 px minimum window, the inspector can reach 480 px.
  - When the inspector is hidden, its handle is removed.
- **Kept sizes:** the dragged inspector width and dock height are kept for the user between runs. The dock holds the Overview, Mixer, Instrument and Backing views.
  - A narrower window clamps a kept size without forgetting it, so a wider window gets it back.
  - Resetting a panel forgets its kept size.
  - Sizes outside 32–4096 px, or unreadable storage, read as automatic. If storage refuses a write, the size still lasts for this run.
- **Not an edit:** sizes are view preferences. They never record an edit or change the score's history.
- **Storage:** sizes use the same local preference store as the view defaults and input preferences (`tabplayer.panelSizes`). They are per user and per machine, not per score.
- **Accessibility and text:** each handle is a focusable `separator` with its value in pixels. The inspector handle's label and hint are in `en`, `et` and `de`.

## Evidence

- **`npx vitest run src/workstation/panel-sizes.test.ts src/editor/EditingToolbar.palette.test.tsx`:** 9 of 9 pass. The store tests cover automatic reads, repair of each field, a round trip, and refused storage. The handle test covers the left and right arrows, End, a pointer drag clamped at both limits, no change after release, and Escape.
- **`App.test.tsx`, "drags the inspector and dock to sizes that are kept…":** passes.
  - Keyboard resizing of both panels, written to storage.
  - A remount that reads the sizes from storage alone.
  - The 960 px clamp that keeps the stored 560 px.
  - The handle removed with the inspector hidden.
  - Escape returning to 264 px and storing `null`.
  - No change to the score's state or navigation.
- **Wider Vitest run** (`src/App.test.tsx`, `src/workstation`, `src/editor`): 1208 pass, 2 fail. The two failures each pass when run alone; they are the known full-run timeouts (THE-173).
- **Typecheck:** clean.
- **Desktop, Windows test build from this branch, 1440 px window** (scratchpad driver, not committed):
  - Opened the instrument fixture. The automatic sizes were 304 px for the inspector and 192 px for the dock, and storage held `{"inspector":null,"dock":null}`.
  - With the real mouse, dragged the inspector edge 120 px left and the dock edge 60 px up. The result was 424 px and 252 px, and both were stored.
  - Stopped the app and started it again on the same WebView2 profile. The inspector came back at 424 px and the dock at 252 px. There were no page errors in either run.
- **Layout fix found on the desktop:** the first desktop run showed the inspector's fields stopping at 272 px inside a wider inspector, leaving a blank strip.
  - The cause: an old `.inspector{width:272px}` rule still applied, because the rule that makes the editor fill the inspector (`.workstation-inspector>.inspector`) stopped matching when the Song, Track and Selection tab panels were added.
  - A rule for `.inspector-tabpanel>.inspector` fixes it. With the inspector at 560 px, the editor is now 528 px and each field 261 px, where before they were 272 px and 133 px.
  - At the automatic 304 px width, the editor now fills the inspector too, about 16 px wider than before.

## Limits

- Sizes are kept per user and per machine in the app's local web storage, not with the score.
- The edition palette on the left is a fixed tool column and is not resizable.
- Only the inspector and the bottom dock are resizable; the panes inside the inspector are not.
- Checked on Windows only.
