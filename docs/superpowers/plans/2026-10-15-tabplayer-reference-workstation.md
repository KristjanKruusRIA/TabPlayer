# TabPlayer Reference Workstation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user has already authorized parallel work and autonomous execution. Root reviews this preparation artifact, joins source changes and owns Git/runtime launches; this plan adds no human permission gate.

**Goal:** Translate the user's supplied workstation collage into a compact, functional score-first TabPlayer shell with actual track overview, mixer and realistic instrument views.

**Architecture:** Retain the current canonical score, commands, native audio and workspace/session lifecycle. Move selected-track setup into a focused pane, move actual mixing below the score, and add a pure written-measure projection plus a bounded accessible grid. Root joins these independent pieces into the responsive shell without replacing the App or native player.

**Tech Stack:** Existing React/TypeScript, CSS, alphaTab engraving, Tauri/Rust native document/audio. No added dependency.

**Spec:** `docs/superpowers/specs/2026-10-15-tabplayer-reference-workstation-design.md`.

## Global constraints

- The authoritative checkout is `C:/Users/krist/.codex/worktrees/tabplayer-rust/TabPlayer`, branch `feat/gp8-parity`; root resolves current source/integration state before execution.
- Mode is Operate. The user's reference is pinned; no new concept tournament, competing image boards or approval round.
- Each implementation worker reads Impeccable's `reference/craft-floor.md` immediately before its first UI edit. This preparation pass does not edit UI and does not invoke the craft-floor or a new context/init run.
- Preserve the Rust/Tauri native score/history/audio/export authority. React panels present real state and invoke existing commands.
- Preserve `AppProps.sessionMenu?:ReactNode`, `AppProps.recoveryStatus?:ReactNode` and optional `WorkspaceApp.session?:WorkspaceSession`, with their native preferences/status/issues/Retry callbacks.
- Root's single imperative `main.tsx` bootstrap creates one React root, resolves the durable session before editing and preserves the mounted App/player through shutdown, destruction and resume. Layout work must not create another bootstrap, player or lifecycle authority.
- The desktop support floor is 960 px. Inspect 960 × 720, 1280 × 900 and 1600 × 1000 in one combined native-window matrix.
- Use the existing realistic guitar, bass, drum and keyboard drawings. No screenshot crops, vendor logos, fake pedals, synthetic waveforms, invented meters or unimplemented recording/clip controls.
- Panel visibility is session UI state, not score history; do not extend recovery serialization for layout preferences.
- No dependency, native command/schema or audio DSP change in this slice. D04/D05/P15 remain honestly scoped; a visual resemblance does not close an inventory row.
- One batched visual inspection, one batch of material fixes, at most one confirmation round, then independent review. Combine with pending recovery runtime checks when the accepted build is shared.

## Review focus

1. Empty/percussion/non-tab tracks and rest-only measures must navigate without changing music or starting/seeking audio; grid keys must not bubble into App playback/range shortcuts — Task 1 ancestor-handler tests and Task 4 integration test.
2. A 32-track/2000-bar score must keep DOM and playback updates bounded while keyboard focus survives scrolling — Task 1 window/focus tests and Task 5 performance receipt.
3. Hidden/relocated panes must retain uncommitted tuning/rhythm drafts and focus, especially at 960 px; Ctrl/Cmd+Shift+V must reveal Inspector before focusing paste options — Tasks 2–4 tests and Task 5 native check.
4. Recovery backup failure, long document names, Retry and Session details must remain reachable during busy/close/resume without a second player — Task 4 tests and Task 5 integrated recovery matrix.
5. Secondary transport errors, repeat occurrence choices and input/dialog shortcut exclusions must survive compacting the toolbar — Task 4 transport/App tests and Task 5 keyboard check.

## Exclusive ownership and join order

All paths below are relative to the authoritative checkout. Each path has one writer. Workers do not run Git, launch the app or change another worker's paths. Tasks 1–3 can prepare independently against the interfaces below. Root performs Task 4 after those files are frozen. Task 5 adapts retained desktop harness callers and runs only after root provides an accepted joined build. Task 5 may prepare fixture/script files while root integrates; all runtime access is serialized by root with the existing harness/device work.

| Task / owner | Exclusive source/test files |
|---|---|
| 1 / overview worker | Create `src/workstation/overview.ts`, `src/workstation/overview.test.ts`, `src/workstation/ScoreOverview.tsx`, `src/workstation/ScoreOverview.test.tsx`, `src/workstation/score-overview.css` |
| 2 / tracks worker | Modify `src/TrackPanel.tsx`, `src/TrackPanel.test.tsx`; create `src/workstation/TrackSettingsPanel.tsx`, `src/workstation/TrackSettingsPanel.test.tsx`, `src/workstation/track-panels.css` |
| 3 / task-pane worker | Modify `src/EditorPanel.tsx`, `src/EditorPanel.test.tsx`, `src/editor-panel.css`, `src/audio/SoundPanel.tsx`; create `src/audio/SoundPanel.test.tsx` only if no existing sound-panel suite owns it, and `src/audio/sound-panel.css` |
| 4 / root shell integrator | Modify `src/App.tsx`, `src/App.test.tsx`, `src/styles.css`, `src/Transport.tsx`, `src/Transport.test.tsx`, `src/ScoreView.css`, `src/workspace/WorkspaceApp.tsx`, `src/workspace/WorkspaceApp.test.tsx`, `src/workspace/document-tabs.css`, `src/workspace/recovery.css`; create `src/workstation/WorkstationLayout.test.tsx` |
| 5 / acceptance worker under root runtime ownership | Create `tests/desktop/workstation-commands.mjs`, `tests/desktop/workstation-fixture.mjs`, `tests/desktop/parity-workstation.mjs`; update retained desktop callers enumerated in Task 5; write `docs/validation/2026-10-15-tabplayer-reference-workstation.md` and evidence under `.analysis/parity/reference-workstation-*` |

`src/main.tsx`, workspace/session coordinators/types, native files, `ScoreView.tsx`, instrument drawings and backing logic remain read-only. If a discovered defect requires those paths, report the evidence to root before widening ownership. Root may document the accepted visual tokens in DESIGN.md plus `.impeccable/design.json` after independent review; this preparation task does not edit them.

### Task 1: Honest written-measure overview

**Interfaces:**

```ts
type OverviewCell = 'empty' | 'rest' | 'music';
interface ScoreOverviewModel {
  barCount:number;
  sections:readonly {bar:number;text:string}[];
  tracks:readonly {index:number;name:string;cells:readonly OverviewCell[]}[];
}
function projectScoreOverview(score:model.Score):ScoreOverviewModel;
function overviewWindow(offset:number,extent:number,count:number,cellSize:number,overscan:number):{first:number;last:number};
interface ScoreOverviewProps {
  model:ScoreOverviewModel;target:BeatTarget;playbackBar:number|null;
  onSelect:(track:number,bar:number)=>void;onExit:()=>void;
}
function ScoreOverview(props:ScoreOverviewProps):React.JSX.Element;
```

`first` is inclusive, `last` exclusive; bounded by `[0,count]`. Grid columns are 28 px minimum, rows 28 px, overscan 2 each axis. A fixed 144 px track-name column stays aligned with scrolled rows. Content classification uses all real staves/voices: no nonempty beats → empty; all nonempty beats rest → rest; otherwise music. Source sections come from real master-bar section text. Every input score in the current app has at least one track/bar; do not add speculative repair logic to this projection.

- [ ] Write projection tests using `blankProject`, `buildScore`/`previewEdit` and authored alphaTab fixtures: empty voice, explicit rest, pitched music, percussion, second staff/voice and named section. Assert every row has `barCount` cells and source score/settings remain unchanged.
- [ ] Write `overviewWindow` tests: `(0,280,2000,28,2)` gives `{first:0,last:12}`; `(280,280,2000,28,2)` gives `{first:8,last:22}`; final window clamps to 2000. Run `npx vitest run src/workstation/overview.test.ts` and observe meaningful failures before implementation.
- [ ] Implement the pure projection/window functions; run that suite to green. No native bridge or player import is allowed in `overview.ts`.
- [ ] Write `ScoreOverview` interaction tests for cell accessible names, one tabbable cell, arrows/Home/End, Enter/Space dispatching only `{track,bar}`, Escape exit, empty/rest selectable cells, virtualized focus retention and actual playback indicator. Wrap the component in an ancestor key handler: unmodified arrows/Home/End/Enter/Space/Escape must prevent default and never reach it, including navigation at bounds; Enter/Space dispatch exactly once even with native button cells, Escape exits once. Tab retains default exit and modified application shortcuts propagate. Mock ResizeObserver/viewport geometry explicitly in jsdom.
- [ ] Implement the grid with visible row/column windows, full scroll geometry and two-cell overscan. Its local handler calls `preventDefault()` plus `stopPropagation()` for grid-owned unmodified arrows/Home/End/Enter/Space/Escape and prevents duplicate native Enter/Space activation; leave Tab and existing modified application shortcuts alone. Keep selected edit cell, keyboard-focused cell and playback marker distinct. Do not recompute the model on each native clock update; parent memoizes by canonical score identity.
- [ ] Run `npx vitest run src/workstation/overview.test.ts src/workstation/ScoreOverview.test.tsx`. For 32 × 2000 at a declared 800 × 112 grid viewport, assert rendered cells remain below 400 rather than 64,000; include scrolled and last-bar focus cases. This bounds UI work without brittle wall-clock thresholds.
- [ ] Freeze owned paths with hashes and report test evidence to root. Root owns any commit.

### Task 2: Move existing track setup and real mix into their working regions

**Interfaces:**

```ts
function TrackSettingsPanel(props:{
  score:model.Score;selected:number;busy:boolean;
  onEdit:(command:EditCommand)=>void;
}):React.JSX.Element;

function TrackPanel(props:{
  score:model.Score;selected:number;busy:boolean;
  view:'overview'|'mixer';target:BeatTarget;onExitOverview:()=>void;
  onSelect:(track:number)=>void;
  onSelectPosition:(track:number,bar:number)=>void;
  player:Pick<NativePlaybackController,
    'subscribe'|'getState'|'mix'|'setMute'|'setSolo'|'setTrackVolume'|'setPan'>|null;
}):React.JSX.Element;
```

The component imports Task 1's projection/view. `TrackPanel` memoizes projection by score and subscribes once for actual mix/playback-bar state. Both Overview and Mixer stay mounted behind `hidden` so keyboard/focus state is retained; only the visible panel is focusable. The parent controls view and renders its dock navigation. `TrackSettingsPanel` is a mechanical move of selected/new instrument drafts, validation and notation-track controls; preserve command payloads and preset behavior. Its state is not duplicated in TrackPanel.

- [ ] Move the existing instrument/tuning/add/remove tests from TrackPanel's suite into the new settings suite with their current behavioral assertions intact. Add a mount/hidden/reveal draft-retention case and long-track-name case. Do not reduce validation coverage to make the extraction pass.
- [ ] Adjust mixer tests for the new props and add live mute/solo/volume/pan dispatch assertions using existing ranges, selected-channel behavior, deletion/undo index change and busy-disabled controls. Run the two suites and retain the expected red failure.
- [ ] Extract the existing settings code into `TrackSettingsPanel`; render real overview or 112 px minimum mixer channels in TrackPanel. Names and ranges stay exact. No meters, dB conversion, additional sound schema or new native commands.
- [ ] Implement only scoped `track-panels.css`; consume root's `--ws-*` tokens without changing global styles. Track-name truncation keeps full accessible names. Put overflow in the content pane, never the body.
- [ ] Run `npx vitest run src/TrackPanel.test.tsx src/workstation/TrackSettingsPanel.test.tsx` plus Task 1 suites once those files are available. Freeze/report owned paths. Transitional App prop errors are root's Task 4 join; do not edit App to hide them.

### Task 3: Compact the existing inspector and sound controls

**Interfaces:** Preserve current `EditorPanel` and `SoundPanel` props, callbacks, action semantics and all tool children/slots. The parent relocates SoundPanel; this task owns its internal presentation. Use the spec's token names and 28 px control heights. Do not modify backing or instrument-view source.

- [ ] Add focused assertions to the existing inspector suite: Edit/Practice/Presentation reveal their real controls, current location stays available, Apply is still required for drafts, hidden/reshown inspector retains duration/text drafts, and invalid/unsupported edits remain reachable without changing the command payload. Run `npx vitest run src/EditorPanel.test.tsx` to establish current behavior and red new assertions as appropriate.
- [ ] Add a sound-panel test only for changed behavior: each of the eight named blocks reports enabled/bypassed state from real settings, opening/closing a block emits no `setTrackSound`, changing an actual parameter emits the correct fixed-chain payload, busy disables changes, and device/preset failures remain visible. Use current controller mocks; do not write tests that merely count CSS classes.
- [ ] Apply compact inspector grouping and scoped sound rows in the owned TSX/CSS files. Existing section labels, units, full technique/gesture/range/clipboard/harmony/lyrics/structure/song/presentation tools stay reachable. Do not replace these groups with decorative icon placeholders.
- [ ] Run `npx vitest run src/EditorPanel.test.tsx src/audio/SoundPanel.test.tsx`; run the existing relevant technique/range tests only if their source wiring changed. Freeze/report paths and evidence. No visual capture or independent tool launch from this worker.

### Task 4: Root joins shell, menus, compact transport and recovery slots

**Consumes:** Tasks 1–3 interfaces. Existing `AppProps` slots and all workspace/native ownership remain authoritative. No new global controller or persistence schema.

- [ ] Read the current joined App/WorkspaceApp/main before editing. Confirm `sessionMenu` and `recoveryStatus` plus root's passing recovery-session tests are present. Record source hashes so an old task packet cannot overwrite the recovery join.
- [ ] Add App/layout tests for File/View disclosure actions, Escape/outside focus return, one open disclosure, keyboard input/dialog exclusions, hidden-pane draft retention, narrow pane switching, dock modes, visibility toggles and focus when closing a pane. Reuse `src/App.test.tsx`'s real WorkspaceController/mocked audio fixture rather than an independent fake application.
- [ ] Add Ctrl/Cmd+Shift+V App/layout regressions invoked from the score in two states: Inspector hidden through View, and Sound occupying the narrow pane. Assert Inspector/paste options become visible and Clipboard summary receives focus after the visibility commit, all mounted tuning/rhythm/text drafts survive, and score/history/musical range remain unchanged with no playback command. Include existing input/dialog exclusions.
- [ ] Add the integration invariant: while mock native playback is running, Overview selection changes target/track/bar through `select` without modifying score identity, project/history/settings, musical range, playback generation, time, loop, phase or prepared plan. Overview Space selects once and issues no play/pause/stop/seek; Overview Escape returns score focus without clearing an existing musical range. Test percussion/empty voice repair too. UI render toggles must not destroy/recreate the player.
- [ ] Add recovery regression assertions to `WorkspaceApp.test.tsx`/layout suite: the one File disclosure includes the actual Restore previous session preference, Retry invokes its existing callback, issue details and long errors remain visible, and ordinary shell updates preserve App/player identity. Keep session-startup's separate no-editor-before-resolution tests unchanged and rerun them after joining.
- [ ] Add Transport tests for More playback revealing seek/loop/occurrence choices and selected range/count-in notices; hidden secondary errors mark the disclosure. Space, Stop and pending/ready disable behavior stay as currently specified. Run focused tests to red for new layout behavior before changing composition.
- [ ] Implement shell composition directly in App using the spec's grid. Add only local state: left task (`track/sound/backing`), pane visibility/narrow choice and dock (`overview/mixer`), while existing `instrumentVisible` selects Instrument. Keep hidden draft-bearing components mounted. Pass new TrackPanel props and move Sound/Backing/TrackSettings into the left-task pane. Preserve all existing modals and callbacks. Set `aria-busy={controlsBusy}` on the existing app shell; it describes document/workspace operation gating, not audio readiness.
- [ ] Update root-owned `showClipboard` so it first reveals Inspector and selects it as the narrow pane. Process a local pending focus intent after that visibility commits: open Edit/Clipboard ancestor disclosures, then focus and reveal Clipboard summary on the same mounted EditorPanel. Do not remount panels, clear drafts/ranges, alter shortcut exclusions or introduce a controller/persistence layer.
- [ ] Move the actual session settings body out of WorkspaceApp's File wrapper into the existing `sessionMenu` ReactNode slot inside App's one File disclosure. Keep preference callback/status ownership unchanged. Render `recoveryStatus` in a footer with 24 px minimum height; allow failure/Retry/detail content to grow or use an escaping disclosure without clipping.
- [ ] Compact Transport into the 42 px primary bar with More playback. Preserve every secondary control and actual error notice; close disclosure focus rules must not trigger playback. Add no new playback shortcut.
- [ ] Define the exact spec tokens in styles.css. Apply 184/284 px side regions below 1440, 208/304 px above; below 1180 use 48 px rail plus one 280 px pane. Use 176/192 px dock heights, 144 px below 800 px height, and Instrument 184/160 px. Keep `min-width:0`, `min-height:0` and local scroll containers; 960 px application floor. Use a measured available score-height check only for the specified below-200 px dock collapse, with no document mutation.
- [ ] Adjust `ScoreView.css` caret/entry colors through tokens without changing engraving or source mapping; preserve blue target versus green playback distinction. Restyle document tabs/recovery CSS via tokens while preserving their semantics and focus trap.
- [ ] Run `npm run typecheck`, `npx vitest run src/App.test.tsx src/workstation/WorkstationLayout.test.tsx src/Transport.test.tsx src/TrackPanel.test.tsx src/EditorPanel.test.tsx src/ScoreView.test.tsx src/workspace/WorkspaceApp.test.tsx src/workspace/DocumentTabs.test.tsx src/workspace/RecoveryPrompt.test.tsx src/workspace/session-startup.test.tsx` and Tasks 1–3's new suites. Resolve failures in the owning files; preserve existing meaningful assertions. Run `npm run build` after passing focused checks. No native success claim from these frontend commands.
- [ ] Root reviews joined source and hands the accepted executable/build identity to Task 5. No source edits from Tasks 1–3 after freezing without a root-coordinated handback.

### Task 5: One combined native acceptance and independent review

**Files:** New `workstation-commands.mjs` exposes `clickWorkspaceCommand(page,name)` for existing File commands: open the one File disclosure when the named command is hidden, click its exact accessible button, wait for `.app-shell[aria-busy="false"]`. This is document-operation idle only; audio flows continue to await actual native status separately. New `workstation-fixture.mjs` uses independently authored redistributable score fixtures with 8-track normal, 32-track/2000-bar long, percussion/non-tab, named sections and real optional backing cases; hash input files. Do not import private demo links or copied scores/assets.

Update existing callers that directly click now-disclosed File actions or use `nav[aria-label="File and history"] button` as an idle proxy. Exact allowed caller paths: `tests/desktop/selection-playback-gestures.mjs`, `parity-clipboard.mjs`, `roundtrip.mjs`, `parity-engraving.mjs`, `parity-selection-playback.mjs`, `parity-document-tabs.mjs`, `native-audio.mjs`, `parity-range-measures.mjs`, `parity-practice.mjs`, `parity-harmony.mjs`, `parity-entry.mjs`, `exports.mjs`, `review-regressions.mjs`, `parity-notation.mjs`, `instruments.mjs`, `performance.mjs`, `critique-fixes.mjs`, `parity-stylesheet.mjs`, `cancellation.mjs`. This is a selector/action adaptation only; do not rerun every expensive historical audio workflow or change its acceptance assertions. Root's joined recovery script, if still separately owned, receives the helper contract through root instead of being edited by this worker.

- [ ] Write `parity-workstation.mjs` against the existing desktop harness. Root runs it using `node tests/desktop/parity-workstation.mjs` with one owned app/CDP session and no concurrent launcher. Respect existing helper ownership and clean up only its own process. No new audio capture helper or native timestamp authority.
- [ ] Behavioral batch: invoke File Open/Save cancellation, selected-score editing/history, Overview click/keyboard navigation while running, real Mixer mute/solo/volume/pan, Instrument actual active-note highlights, View focus/draft preservation and More playback occurrence/error routes. Include Ctrl/Cmd+Shift+V with Inspector hidden and Sound replacing it, plus grid Space/Escape with an existing musical range; verify visible/focused paste options and no unintended play/pause/stop/seek or range clear. Compare document snapshot, native status/generation/loop/phase and input hashes before/after view-only actions. Keep actual mix edits and history assertions separate from navigation invariants.
- [ ] Long-score check: record mounted cell count and native-status continuity at 32 × 2000. Confirm no body horizontal overflow, focus loss or full-grid regeneration on playback ticks. Use a bounded structural acceptance plus observed interaction; do not claim precise speed from one clock reading.
- [ ] Combine with root's pending recovery acceptance on the same accepted build: preview long document names/list, busy restore, backup failure/Retry/details, close cancellation, destroy failure/resume. Root retains the durable recovery/store assertions. This visual slice adds no independent claim of native recovery correctness.
- [ ] Capture one deliberate batch: 1280 × 900 Overview/default; 1600 × 1000 Mixer; 960 × 720 with Sound replacing Inspector; 960 × 720 Instrument; 1280 × 900 expanded inspector; 960 × 720 real error/recovery state. Capture additional required recovery screens in that same batch rather than replaying old acceptance. Open every resulting image once and confirm names match loaded/nonblank content.
- [ ] Read Impeccable craft-floor immediately before actual UI edits (implementation workers, not this planning worker). Run its detector once on changed webview UI targets when no hook ran; classify findings without restarting a critique. Fix all material inspection defects in one coordinated batch, rebuild once and confirm at most once over the same required sizes/states.
- [ ] Give a fresh independent reviewer the original request, collage path, spec/plan, exact changed-file list, current executable/source hashes, all required screenshots, functional receipts, residual detector findings and explicit limits. The reviewer does not inherit implementation optimism. Root handles disposition and any mandated response; no worker self-certifies visual fidelity.
- [ ] Write the versioned validation report with actual executed checks, screenshots/hashes, view-only invariants and open D04/D05/P15 limits. Do not alter frozen baseline counts or mark full GP8 parity delivered. Root records accepted visual tokens in the durable design artifacts after review and integrates Git.

## Preparation self-review

The spec's hierarchy, size breakpoints, token values, menu/recovery slots, draft/focus rules, real overview/mixer/instrument semantics, busy/error states and bounded verification each map to a task above. The only new state schema is local UI state; no native/recovery protocol is introduced. Functional timeline breadth beyond written-cell navigation, draggable splitters, waveform rendering, recording and instrument editing are explicitly excluded and remain separate parity work. Ownership is nonoverlapping; root alone joins shell files, controls runtime and commits. This document is a plan, not execution evidence.
