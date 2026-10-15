# TabPlayer reference workstation design

Date: 2026-10-15. Mode: **Operate**. Status: implementation preparation for root review; this document supplies no implementation or runtime acceptance claim.

## Intent and authority

The user asked: **“Please use these images as the base for the UI.”** The supplied collage is `e:/git/jeopardy/.codex-remote-attachments/01a13a5f-2744-7412-b854-bffaad5f5d85/dc0af941-4ef8-4586-bc2b-e33864b0c32e/1-1000013371.jpg`. It was inspected directly. This direction replaces the earlier instruction to keep the layout, while preserving working tools and the authorized full GP8 parity effort. The user's standing authorization to proceed and use parallel work governs execution; no additional design permission round is required.

TabPlayer should feel like a compact music workstation where a player can read and edit a score, rehearse an exact passage, shape a track's real sound, and inspect the performing instrument without losing their musical location. The score remains the dominant artifact. Dense controls are organized by task and remain readable rather than copying the collage's tiny text.

Confirmed reference observations:

- Charcoal chrome surrounds a central light score; controls use narrow rows, restrained borders and blue selection.
- The left side groups notation tools and sound/effect controls. A right inspector exposes interpretation, notation and sounds.
- The lower part of the professional view combines an audio strip and colored track/bar overview. A separate multitrack image pairs horizontal tracks with mixer channels.
- Instrument setup and fretboard occupy dedicated working space. Another image shows contextual articulation and performance controls over the score.

Assumptions and tradeoffs:

- Translate the composition and hierarchy, not vendor branding, illegible labels, exact dimensions or screenshot pixels. Keep the TabPlayer name.
- Use the existing realistic guitar, bass, drum and keyboard drawings. They are authored product assets; they must not become simplified diagram substitutes.
- Keep light score paper in the dark workspace. Do not recolor engraved glyphs through broad dark-theme selectors.
- Preserve the Rust/Tauri native score/history/audio/export authority. React panels present real state and invoke existing commands.
- The desktop support floor is 960 px. This plan covers 960, 1280 and 1600 px widths, including a 720 px short window. A phone app is outside this surface's current platform contract.
- Compact track mix controls are already functional. The score overview described below is a bounded new navigation feature. The reference's waveform and DAW clips are separate functionality and cannot be represented as working controls or fabricated data.

## Source truth and functional boundary

Source inspected: `src/App.tsx`, `src/TrackPanel.tsx`, `src/Transport.tsx`, `src/EditorPanel.tsx`, `src/audio/SoundPanel.tsx`, `src/audio/BackingPanel.tsx`, `src/ScoreView.tsx`, `src/ScoreView.css`, `src/styles.css`, `src/editor-panel.css`, `src/instruments/LiveInstrumentView.tsx`, `src/instruments/InstrumentView.tsx`, `src/instruments/instruments.css`, `src/workspace/WorkspaceApp.tsx`, `src/workspace/RecoveryPrompt.tsx`, `src/workspace/recovery.css` and `src/workspace/types.ts`. Discovery graph tools were not exposed, so source/file search was the available fallback. No PRODUCT.md or DESIGN.md was present in the authoritative worktree; its only discovered Impeccable file was a previous critique, which is not reissued as this design.

The versioned parity progress overlay, `docs/validation/2026-10-15-gp8-parity-progress.md` and its JSON companion, is the inventory, not a live claim that every carried row remains absent. Its W05 description is already superseded by the inspected `WorkspaceApp` and document tabs. Root's recovery/session frontend join was then reread: `AppProps` has optional `sessionMenu?:ReactNode` and `recoveryStatus?:ReactNode`; `WorkspaceApp` has optional `session?:WorkspaceSession`. Preserve these exact slots and the live native preferences/status/issues/Retry bindings. Root's single imperative `main.tsx` bootstrap creates one React root, resolves the durable session before editing and preserves the mounted App/player through shutdown, destruction and resume. Layout work must not create another bootstrap, player or lifecycle authority. Native recovery/store acceptance remains a separate pending workflow.

| Area | Existing truth to preserve | Change in this slice | Explicit limit |
|---|---|---|---|
| Score and D03 visibility | Selected/all/chosen tracks, engraving projection, zoom, canonical selection and playback mapping | Larger paper region and compact display toolbar | No new page/horizontal rendering or fit-mode claim (D01/D02) |
| Track mix | Actual mute, solo, volume and pan through `NativePlaybackController` | Bottom channel rows or strips instead of tall left cards | No peak meter without measured signal; no recording/clip editing |
| D04 overview | No global bar grid in the inspected source | Real written track/bar cells, sections, selected target and playback bar; click/keyboard navigation | No reorder, drag selection, repeat-expanded audio timeline or full D04 closure |
| D05 panels | Fixed side panels and instrument toggle | Explicit show/hide and responsive pane switching | No draggable splitters or persisted panel-width preference in this slice |
| Sound | One fixed gate → compressor → amp → cabinet → EQ → chorus → delay → reverb chain | Compact block list with enabled state and real parameters | No reorder, duplication, alternate effect families or preset audition claims (A07/A11/A37) |
| Backing/P15 | Real import/replace/remove, offset, gain/pan and synchronization anchors | Same controls in a reachable Backing pane; factual filename/duration summary | No synthetic waveform, drag sync or timeline peaks; P15 remains separate |
| Instruments/U11–U15 | Native active-note viewers; separate scale preview | Dedicated lower Instrument view with existing mode/size controls | No new click-to-enter, stopped-note preview, handedness or simultaneous views |
| Recovery/session | Root-owned typed preview/actions, workspace busy ownership and activation leases | Match new chrome using presentation changes only | No changed restore/discard semantics or automatic playback |

Do not upgrade a parity inventory row based on a visual resemblance. Any new functional row needs its own scoped behavioral evidence.

## Selected approach

Use a workstation shell around the existing score engine and command panels. Extract the selected-track setup controls from `TrackPanel` so the left rail can hold Track, Sound and Backing while the existing track mix moves below the score. Keep `EditorPanel` as the right context inspector. Add only a small pure score-overview projection and its accessible view; the remaining change is composition and presentation.

Two alternatives were considered. A CSS-only recolor is smaller but cannot produce the requested bottom tracks/mixer hierarchy or recover useful score width. A new DAW-style arrangement subsystem resembles the collage more literally but adds recording, clip and waveform semantics absent from the source. The selected approach carries the recognizable composition with the smallest honest functional addition.

## Screen composition and sizing

At 1280 × 900 the first viewport has a 34 px command bar, 30 px document-tab row, 42 px primary transport, a flexible workspace, and a status bar with 24 px minimum height. Error/notice and recovery failure rows take the height their actual message/actions need; do not clip Retry or Session details to the normal footer height. Within the workspace, the upper row has a 184 px left pane, a flexible score and a 284 px inspector. The bottom dock spans left pane plus score, while the inspector continues to the bottom. The bottom dock is 176 px in Overview/Mixer mode. Its header is 30 px and its content scrolls independently.

```text
┌ File  View  Undo Redo       document title / dirty       Help ┐
├ document tabs / current document                            ┤
├ Play Stop  time  speed  tempo  metronome   More playback     ┤
├ Track/Sound/Backing ┬ score display controls ┬ Inspector     ┤
│  left pane         │                        │ Edit          │
│  actual settings   │     cream score        │ Practice      │
│                    │                        │ Presentation  │
├ Overview  Mixer  Instrument ────────────────┤               │
│ actual tracks × written measures OR mix OR instrument      │
├ saved/unsaved / operation status / path                      ┤
```

| Width | Left region | Right inspector | Bottom dock | Result |
|---|---|---|---|---|
| 1600 px | 208 px expanded by default | 304 px | 192 px | About 1088 px center; readable simultaneous tracks |
| 1280 px | 184 px expanded by default | 284 px | 176 px | About 812 px center; selected score remains dominant |
| 960 px | 48 px navigation rail | 280 px, inspector by default | 160 px | About 632 px center; one side detail pane at a time |

At widths below 1180 px, Track/Sound/Backing selection opens a 280 px pane on the right in the inspector's place. Selecting Inspector restores that pane. The 48 px left rail retains labeled accessible buttons with tooltips; its visible labels may use short text such as Track and FX rather than unreadable stacked words. Do not overlay the narrow pane on the score or show both wide sidebars. At 1180–1439 px use the 1280 geometry; at 1440 px and above use the 1600 geometry.

Hide left details, Inspector and bottom dock through View controls. Hidden panels remain mounted when they contain draft inputs; switching views must not commit, clear or reset those drafts. At 960 px the narrow pane choice overrides simultaneous visibility. Opening a hidden pane returns its previous task section and scroll position. Panel visibility is session UI state, not score history; do not extend recovery serialization for layout preferences.

At window heights below 800 px, use a 144 px Overview/Mixer dock. Instrument mode uses 184 px at normal height and 160 px below 800 px, with its own scroll area when necessary. Retain a flexible score area with `min-height:0`; the paper, panes and dock scroll independently. If chrome plus a real error banner leaves less than 200 px score height, collapse the bottom dock to its 30 px header until the user opens it. Do not shrink fonts to make everything fit.

The cream paper has 16 px outer breathing room at 1280/1600 and 10 px at 960; retain the engraving renderer's own score margins and native glyph fonts. A high zoom or intentionally wide system scrolls inside the paper region. The application body and command bar must not acquire horizontal overflow.

## Primary controls and task hierarchy

The command bar contains File, View, Undo, Redo and Help. File holds the existing New, Open, Save, Save As, Close score, Close all scores, Export score and Export GP callbacks plus the existing `sessionMenu` content. The current slot includes its own File disclosure; root's shell task moves that disclosure's Session settings body into the single App File disclosure while preserving the ReactNode slot and its real callbacks. Never nest File disclosures or duplicate the Restore previous session preference. Keep `recoveryStatus` in the footer with Retry, errors, backup time and Session details reachable. The visible document title truncates after flexible space; full title/path remains available through accessible text/title. Dirty dots and selected document tabs remain visible.

Use native disclosure semantics for File/View/Help containing ordinary buttons and labels. Do not set ARIA menu roles without implementing their complete arrow-key interaction. Enter/Space opens the disclosure, Tab reaches each command, Escape closes and restores focus to the trigger, and pointer outside closes it. Popovers must escape scrolling/overflow containers and stay within the window. Use one open command disclosure at a time.

Expose `aria-busy={controlsBusy}` on the existing application shell for document/workspace operations. Desktop acceptance waits on this actual operation gate, rather than guessing idle from the first history button, which can legitimately be disabled with no undo history.

The primary transport exposes Play/Pause, Stop, actual elapsed/total time and measure, speed, actual BPM and metronome. A disclosure named **More playback** contains seek, loop start/end and the existing occurrence/selected-passage controls, count-in/progressive settings notices and errors. Do not remove ambiguous-repeat occurrence choices to save width. Errors associated with hidden secondary controls also produce an error indicator on More playback, with the full error available when opened. Keep Stop available whenever the existing player permits it, including during loading or settings transitions; preserve current disable rules rather than deriving them from styling.

The left pane has Track, Sound and Backing task buttons. Track owns selected track name, short name, MIDI program, tuning, add/remove and notation-track controls. Sound contains the actual voice/preset/output selectors and eight fixed effect blocks, each showing its real enabled/bypassed state. Opening one block reveals its current controls. Style it as compact hardware-informed rows, not fake stompbox thumbnails, fabricated knobs or copied vendor pedals. Backing exposes existing import and anchor tools. Labels always identify parameter units; turning a disclosure does not change the sound.

The inspector retains Edit, Practice and Presentation. Keep the selected track, measure, beat, staff, voice and string/note context sticky at its top. Edit holds note/rhythm, techniques, gestures, ranges, clipboard, transpose, text, measures, directions, structure and lyrics; advanced groups disclose progressively. Practice keeps the real tempo/count-in/metronome/progressive controls. Presentation keeps engraving, page layout, score/song metadata. Existing action buttons retain their commit semantics; do not turn every draft field into live edits.

The existing `showClipboard` / Ctrl/Cmd+Shift+V navigation must first reveal the Inspector and select Inspector as the active narrow pane, including when View hid it or Sound/Track/Backing replaced it. After visibility commits, open its Edit/Clipboard ancestor disclosures, then focus and reveal the Clipboard summary. Use the same mounted EditorPanel and preserve all drafts. Opening paste options changes no score, history, musical range or playback state. Preserve the shortcut's existing input/dialog exclusions; a small local pending reveal/focus intent is sufficient.

The dock has **Overview**, **Mixer** and **Instrument** choices with selected state and one visible panel. These are view controls, not document mutations. Overview/Mixer share one mounted `TrackPanel`; Instrument uses the existing `LiveInstrumentView`. Selecting Instrument maps to existing `instrumentVisible` state so per-document recovery retains the established visibility contract. Overview versus Mixer is local presentation state and may reset to Overview on document reactivation.

## Overview and mixer contract

The overview represents **written measures**, not unfolded playback seconds. Every column is equal-width with a minimum 28 px width; columns beyond available width horizontally scroll inside the grid. Show written measure numbers, actual section names when present, one named row per real track, a subtle occupied/rest/empty distinction derived from beats, a blue edit-target outline and a separate green playback-bar indicator. An empty or rest-only measure remains a selectable real measure. Do not infer chord, section, note-density waveform or audio clips where no source data exists.

Grid interaction: click a cell chooses that track and measure using the existing App selection/repair flow. Use staff 0 and voice 0, beat 0 as the requested address; repair handles empty voices as it already does. It does not seek native audio, change a loop or write music. Keep focus on the cell after selection so arrows can navigate the grid. One cell is tabbable; arrows move within track/bar bounds, Home/End move to first/last bar, Enter/Space selects the focused cell. Tab exits the grid; Escape returns focus to the score without changing the edit target or existing musical range. Accessible names identify track, written measure and content state. Numeric measure input in the inspector remains an independent accessible route.

ScoreOverview owns its unmodified arrows, Home/End, Enter/Space and Escape events locally: call `preventDefault()` and `stopPropagation()` for each handled key, including navigation at grid bounds. Enter/Space selects exactly once even when a cell uses a native button; suppress its duplicate browser activation. Escape exits exactly once without reaching the App handler that clears a musical range. Grid Space must never bubble into the App Play/Pause shortcut. Keep Tab's normal behavior and allow existing modified application shortcuts to propagate. These rules belong to the small grid handler, not a new shared keyboard framework.

The playback indicator reads the actual `NativePlaybackController` state.measure and ready/phase state. Repeated visits light the same written bar; no false occurrence-expanded ruler. Following playback must not steal focus or scroll the user's score selection. Invalid/not-ready state shows no playhead. Use a single overlay/indicator update rather than recomputing all track/bar contents every native clock event. Project occupancy/sections once per canonical score identity; render visible bar columns and track rows with bounded overscan. A 32-track, 2000-bar score must not mount 64,000 focusable cells. When the focused cell leaves the visible range due to user scroll, keep a valid focus target or move the rendered window to retain it.

Mixer mode shows one real channel strip per track with track name, selection, mute, solo, volume and pan; 112 px minimum channel width and horizontal scrolling. Retain exact control ranges: volume 0–1, step .05; pan −1–1, step .05. Keep label/value text or an accessible value for each slider. No animated level meters or decibel labels inferred from linear gain. The selected track uses both a border/marker and text state; track identity colors are muted tags, not entire saturated panels. Track order stays canonical.

## Visual system

| Token | Value / use |
|---|---|
| `--ws-bg` | `#171a20`, deepest workspace |
| `--ws-panel` | `#23272f`, side panes and dock |
| `--ws-raised` | `#2c313b`, headings, selected-neutral rows |
| `--ws-input` | `#1b1f26`, controls |
| `--ws-border` | `#434b59`, structural/control boundaries |
| `--ws-text` | `#edf0f5`, primary text |
| `--ws-muted` | `#b5bfcc`, secondary text |
| `--ws-accent` | `#79aaff`, active commands/selection and dark-surface focus |
| `--ws-accent-ink` | `#17243a`, text on filled accent |
| `--ws-paper` | `#fffdf5`, score sheet only |
| `--ws-paper-surround` | `#6f747c`, neutral contrast against dark chrome |
| `--ws-edit` | `#245cb2`, blue caret/selection outline on paper |
| `--ws-playback` | `#9ccc75`, native playback indicator; on paper use existing dark green ink |
| `--ws-error` / `--ws-error-surface` | `#ffd2c7` / `#5b2c2b`, factual failures |
| `--ws-warning` | `#e8c27b`, pending recovery/limited capability information |

Use system sans at 13 px with 1.35 line height; 12 px labels, 11 px metadata only, 14 px section titles. Keep bundled notation fonts unchanged. Numeric time, tuning and measure values use tabular figures where appropriate. Spacing scale: 4, 6, 8, 12, 16 px. Control height is 28 px, primary transport 30 px, compact icon targets at least 28 × 28 px with accessible names and tooltips. Radius is 3 px for controls, 4 px for dialogs. Use flat dividers and restrained inset depth; shadows only separate paper or floating overlays.

Focus is a visible 2 px outline with 2 px offset; the score keeps its blue edit target distinct from keyboard focus. Selected state uses shape/text as well as color. Disabled state retains legible labels and a visible disabled affordance. Check text contrast against actual token pairs during implementation. Avoid blanket opacity on whole busy panels. No decorative page-entry animation; optional control transitions are at most 150 ms and respect reduced motion.

## States, focus and recovery

| State | Required behavior |
|---|---|
| New blank score | Real empty/rest measures render; track name and navigation work; import/setup actions are reachable |
| Loading native audio | Keep score editing/navigation available according to current busy ownership; transport says “Loading local audio…”; no fake running time/meters |
| Applying practice settings | Keep actual pending notice and existing disabled transitions; no duplicate start request |
| Busy document operation | Existing `controlsBusy`/workspace operation gates remain authoritative; busy command has factual status; drafts and selection survive cancellation |
| Playback / pause / end | Preserve Space, Stop, range/occurrence rules, count-in and selected-passage notices; show actual measure and instrument notes |
| Invalid tuning/unsupported edit | Keep field error and focus behavior; error remains reachable in a scrolled/collapsed pane |
| Audio/output failure | Show actual message near transport or Sound; existing retry/device controls stay reachable; no “ready” or successful playback claim |
| Export | Existing modal progress, cancellation and owner lock remain intact; closing returns focus to initiating command |
| Dirty document switch/close | Root workspace prompts/tabs/activation leases control behavior; no panel effect implicitly saves or discards |
| Recovery preview | Keep real document list, checkpoint time, issues and distinct Restore/Discard/Start new actions; contain long titles and large lists |
| Recovery busy/automatic clean restore | Retain focus trap and busy state; no Escape dismissal, music editing or automatic playback behind prompt |
| Recovery unavailable or startup failure | Preserve the root-integrated factual state and explicit recovery/start-new path; visual work must not replace it with an empty shell |

Do not hijack keyboard editing: score arrows, digits/Enter and Shift range keys remain local to the score; Ctrl/Cmd N/O/S/Z/Y, clipboard, W and Tab keep current input/dialog exclusions. Grid arrows are handled only inside the grid. Opening a pane through keyboard puts focus on its task heading/first useful control; closing returns it to the triggering View/rail button. Switching dock mode does not focus the score automatically. A pane hidden while focus is inside it must move focus to the corresponding visible trigger. Dialog focus stays authoritative over shell disclosures.

## Verification and acceptance

1. Behavioral tests prove overview navigation is view-only; canonical score/history/settings, native playback generation/time/loop/phase, musical range and backing state remain unchanged. Test empty voices, rest bars, percussion/non-tab tracks, sections, repeated playback and long scores. An ancestor-handler case proves grid-owned keys do not bubble; actual-shell cases prove Space issues no play/pause/stop/seek and Escape returns score focus without clearing a musical range.
2. Existing App, TrackPanel, EditorPanel, Transport, ScoreView, document-tab and recovery/session tests continue to pass. New shell tests exercise menus, panel focus, draft retention, keyboard exclusions, cancellation and busy errors. Test Ctrl/Cmd+Shift+V from the score with Inspector hidden and with Sound replacing it at narrow width: paste options become visible/focused after the reveal, drafts survive, and no score/history or playback mutation occurs. Tests assert user-observable behavior rather than CSS class names.
3. Root runs typecheck, the changed frontend suites and build. Audio/score native suites are rerun only if integration changes those contracts; visual-only edits do not justify new audio fidelity claims.
4. One batched native-window inspection includes 960 × 720, 1280 × 900 and 1600 × 1000; capture Overview, Mixer, Instrument, a long expanded inspector and recovery/error states as a deliberate matrix. Validate that each image is loaded, nonblank and corresponds to its named state. Test pointer and keyboard flows in the same session.
5. Apply all material defects from that inspection in one batch, confirm with at most one further capture round, then stop polishing. Pass the original collage, spec, screenshots and exact changed paths to a fresh independent reviewer. Root owns review disposition, any warranted correction and integration; no stale critique or endless visual loop.

Accept when the collage's recognizable hierarchy is present, the paper has usable width at all three sizes, every existing tool remains reachable, actual mix/overview/instrument views work, menus/recovery/focus remain sound, and no screenshot resemblance is used as evidence of unimplemented parity.
