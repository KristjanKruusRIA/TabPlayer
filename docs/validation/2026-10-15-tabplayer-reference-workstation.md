# Reference workstation validation — 2026-10-15

Status: normal runtime/visual, actual **32-track/2,000-measure long-score**, selection gestures, final affected verification and joined source/evidence review pass at their recorded stages. The joined window-destruction/resume P2 is resolved with no open P1/P2 in that review. Actual destruction-exception injection is **unsupported on this host and was not executed**; verified source delivery and the later CI limitation are recorded in the appended checkpoint. This report does not mark the overall goal complete or claim full GP8 parity.

## Scope and source identity

Authoritative checkout: `<checkout>`, supplied branch `feat/gp8-parity`. The accepted design is `docs/superpowers/specs/2026-10-15-tabplayer-reference-workstation-design.md`; execution plan is `docs/superpowers/plans/2026-10-15-tabplayer-reference-workstation.md`. The user's original collage remains the reference for the charcoal shell, cream score, task panes and lower overview/mixer/instrument hierarchy. Generated recovery/export concepts cover those additional dialogs; generated incidental content is not product truth.

Root owns the app, diagnostic build, native execution, screenshot inspection, review and Git. This report records retained receipts; its author ran no apps, tests, builds, Cargo or Git for this documentation pass.

| Historical normal-batch artifact | SHA-256 |
|---|---|
| `.analysis/desktop-smoke/tabplayer.exe` | `5E8EBF4E2733CE12A8CD43ECBD715AA6C43B8C940FD75313BFC139827D9516AC` |
| `src/workstation/workstation-shell.css` | `BD08165429B64021296980E38C712C1936EDF38060EAEED935BCCE3438DD179F` |
| `tests/desktop/parity-workstation.mjs` | `9AE79B767569DC6795BCE7FC373FF85484A603A64BF24964C32AEB52A7C5A68F` |
| `tests/desktop/workstation-fixture.mjs` | `114C9F6C96AF3B6D9187EDDD1AC5279092813C5C27956E40CF8B2A4AAA85BA3F` |
| `tests/desktop/workstation-commands.mjs` | `684819B14AEEDB61673B9ECECF2E16665C5BD10A40B1BDAB625785073BBC94BD` |
| Final normal result JSON below | `D9E6F53F117A9B86415951A79DFF10FAEDA6D7C1DDD29006C77ADE78FA09CBC7` |

Normal-batch build receipt: `.analysis/parity/recovery-workstation-desktop-build-visual.log`. The Windows diagnostic `tauri build --no-bundle --features desktop-test` completed with exit 0; its frontend `tsc --noEmit && vite build` succeeded. Vite retained its greater-than-500-kB chunk warning. This was a diagnostic executable, not a packaged production release. Later performance changes and the separate long-score executable are identified below; the historical normal hashes are not presented as current source hashes.

## Executed checks and precise limits

| Check | Actual outcome and receipt |
|---|---|
| Joined frontend sweep | 129 files: 128 passed, one failed; 1,778 tests passed, five failed, one skipped. All five failures were old tuning-UI routes after controls moved. `.analysis/parity/recovery-workstation-joined-frontend.log` |
| Affected tuning migration | Five/five passed after adapting the real Track/Inspector entry routes. `.analysis/parity/workstation-task-4-tuning-migration-green.log`; typecheck exit 0, quiet `.analysis/parity/workstation-task-4-tuning-migration-types.log`. The entire 129-file sweep was not repeated or represented as freshly all green. |
| Later whole frontend sweep | **132 files / 1,793 passed / one incumbent benchmark skipped**, 119.56 s, `.analysis/parity/recovery-workstation-final-frontend.log`. This stage predates the pickup P2 and selected-playback performance corrections; it is not a final-source all-green claim. |
| Final cohesive affected verification | **16 files / 342 passed / one incumbent benchmark skip**, 36.71 s, exit 0; `.analysis/parity/recovery-workstation-final-affected.log`. Includes the final resume correction and retained performance/selection/recovery/workstation coverage; no new full-suite rerun is implied. |
| Joined native Rust 1.88 | 334 passed, zero failed, six ignored; exit 0. `.analysis/parity/recovery-workstation-joined-native.log` |
| Native manual budget acceptance | Two explicitly ignored tests run separately: two passed, zero failed. `.analysis/parity/recovery-native-budget-run.log`; scoped explanation/measurements `.analysis/parity/recovery-native-budget-report.md`; independent review `.analysis/parity/recovery-native-budget-review.md` PASS. These native serialization/store observations are not workstation rendering or audio-fidelity measurements. |
| Resource/package checks | Ten passed, zero failed. `.analysis/parity/recovery-workstation-joined-resources.log` |
| Joined Rust formatting | Exit 0. `.analysis/parity/recovery-workstation-joined-fmt.log` |
| Impeccable detector | Successful corrected invocation returned `[]`, exit 0, retained at `.analysis/parity/workstation-impeccable-detector.json`. An earlier invocation used an invalid old TrackSettingsPanel path and failed operationally; it did not scan that nonexistent target. |
| Final normal native workstation batch | 12 check groups, six captures, zero page errors, `long:false`, `backing:true`. `.analysis/parity/workstation-native-confirmation.log` and `.analysis/desktop-smoke/workstation-1792077539539-a6e2e38f-4cac-4e50-af0d-11f75871413e-result.json` |
| Native long-score batch | **PASS at the pre-resume-correction build stage:** 11 check groups, zero captures/page errors, `long:true`, `backing:false`. `.analysis/parity/workstation-native-long-final.log` exit 0 and `.analysis/desktop-smoke/workstation-1792080256568-4c913204-9cda-4d3a-8624-58caee40c5a0-result.json`. |
| Post-resume-correction normal native batch | **12 check groups**, zero captures/page errors, `long:false`, `backing:true`; final executable `8A8CB8B4…`, `.analysis/parity/recovery-workstation-resume-final-normal.log` exit 0. Exact result and build identity below. |

The normal fixture is an independently authored eight-track, 16-measure score with pitched guitar/bass/piano, percussion, rest/empty voices and named sections, plus an original eight-second backing WAV. Actual acknowledged native prepared notes are compared to its literal note oracle. Input hashes in the final result are:

- GP source: `5d7cddf0f94b3da5df2b2239b464f7b5b2e132d221425d537d11aef5b6054429`.
- Backing WAV: `d25de7702f2faab81427cff908ca1456e3cd492b02af229363303897cd609e94`.
- Fixture manifest: `d759d6d98f84d13ccae77166cfca64604293fa5e8723605f5eaafb2e4e8ef26e`.

## Functional receipts

The driver uses the mounted UI and observes public native IPC bodies and actual native status. Its assertions distinguish document edits from view-only navigation:

- File Open loads the authored source; Set note, Undo and Redo change native document revisions and the expected project edit history. Save writes the applied project. Production Open and Save pickers were separately cancelled through their real native picker routes, preserving the full document/workspace snapshots. Diagnostic File routing uses fixed paths; this is not a claim about a dirty Close → Save → picker-cancel sequence.
- Mixer mute/solo and keyboard slider steps dispatch addressed `setTrackMix` edits. The final native mix has gain `.55` and pan `-.25` for `base/0`, and its IPC owner matches the captured active document/activation. The slider increments remain `.05`; real mute/solo controls are cleared again through addressed edits. No meter or inferred dB is shown.
- While native playback runs, Overview click, arrows, Space/Enter, Home/End and Escape preserve the full native document record, active owner, generation/desired generation, phase, range, loop, prepare count and plan hash. No native transport command is added. Escape returns score focus and preserves the existing musical range summary. Time advances normally rather than resetting: the recorded navigation interval is `.13` to `.59` seconds, generation 12, phase `playing`; it is not described as a frozen clock.
- Clock-only updates retain the first mounted overview cell and produce zero grid child-list mutations in the normal fixture. The receipt records 128 mounted cells at a 981 × 145 grid viewport; the separate long-score bound is established below.
- The real piano view's active key is checked against the literal authored note at the paused native tick: track 3, key 60, tick 1670.4. The tick remains fixed while the actual highlight is inspected. This is a native-state/highlight check, not PCM or physical audio capture.
- Ctrl+Shift+V on Windows reveals the mounted Inspector and focuses Musical clipboard both when Inspector was hidden and when the narrow pane was occupied by Sound. Duration draft `8`, document identity/revision and native generation/play/range/loop survive. Track tuning draft `D4 A3 F3 C3 G2 D2` also survives hiding/switching. Controls remain real disclosures and drafts still require their existing Apply actions.
- More playback retains its secondary controls and a real invalid-loop error, “Loop end must follow its start.” The final overlay begins below the visible error feedback rather than covering it.

The normal straight 4/4 fixture does not exercise ambiguous repeat occurrences; retained occurrence controls and existing tests are not promoted to a new repeated-performance runtime claim.

## Actual long-score acceptance and bounded performance corrections

The actual long-score executable SHA-256 is **`4D1A140423C6284F7A4F13E29F410745F729E444D4C0A9FFADEE5CC324B3E6CC`**. `.analysis/parity/workstation-large-score-final-desktop-build.log` records the Rust 1.88 release build completing in **39.51 s**. Its result JSON **`workstation-1792080256568-4c913204-9cda-4d3a-8624-58caee40c5a0-result.json`** has SHA-256 **`B7EEEFEE2465A122FDD64CCBDBA9FAD2FC2667F6426A12AF01015558A7D3961E`**. This run completes **11** groups with `long:true`, `backing:false`, `captures:false`; the normal batch has 12 because it additionally exercises backing. The normal six-capture evidence is retained without another visual-polish loop.

The authored long fixture contains **10,360 literal notes**, **32 tracks** and **2,000 measures** (64,000 track/bar cells, not 64,000 notes). Its GP SHA-256 is `75f6d0ab7b00591c2cc97caa10c4cfb0f31b2211550b0388db27743771c70402`; fixture manifest SHA-256 is `3b77b90cb8eca207a96fbcd1f4cfb6e3314992a54a4f181daaf8707066e3a8f9`. The source is rehashed and actual native prepared notes are checked against the independent literal oracle. File/history/save, real native picker cancellation, addressed mixer edits, Overview navigation, grid continuity, Instrument, Clipboard reveal, tuning draft and More playback complete without page errors. Final native status is Ready/stopped, tick zero, phase idle and no error.

At the **981 × 130** grid viewport, the long run mounts **224 cells ≤ 316** viewport-derived budget, retains the first cell and records **zero child-list mutations** during clock updates. While Overview navigation runs, generation/desired generation remain **12**, and the document, owner, range, loop, prepare count and plan hash remain unchanged. Actual tick advances **12311.04 → 27191.04**; plan SHA-256 is `148b75f36778dbe7c46723feaae76d087b6874f6b307b937b1a5ad61539de550`. Piano track 3 shows literal key **60** at paused tick **48829.44**. These are bounded DOM/native-state continuity results, not PCM fidelity, independent 32-channel sound, comparative timing, memory savings or physical audio-quality measurements. The straight 4/4 fixture reuses MIDI channels and makes no repeat-occurrence claim.

Two earlier long attempts were bounded root aborts and remained failed/open evidence; they are not retroactively reported as PASS. Initial browser traces identified repeated whole-score conversion/preparation. A later actual **eight-second early browser trace** (`workstation-long-optimized-early-cpu-trace.json` and summary) isolated `rowsIn` repeatedly filtering all performed rows per occurrence through cursor choices, with Transport repeating queries on native-clock renders. This is actual profiling evidence; it does not supply a reliable before/after speed ratio or native-fidelity benchmark.

The correction stays within five production paths: `src/model-clone.ts`, `src/audio/plan.ts`, `src/audio/NativePlaybackController.ts`, `src/audio/selection-playback.ts` and `src/Transport.tsx`. It reuses parsed/canonical scores, narrows transient lane conversion with full-score fallback for cross-track relationships and pickup timing context, indexes query rows per call, and memoizes render queries across clock-only updates. Public validation and action-time checks remain; playback generation/owner authority is unchanged. Full prepatch plan oracles and an independently captured legacy pickup plan guard musical semantics. A real-controller preparation-readiness regression prevents the Transport memo from retaining empty occurrence choices after preparation completes.

Final affected receipts are **149 passed / one incumbent benchmark skip across seven files** (`workstation-large-score-pickup-affected-green.log`) and **37 passed across five files** (`workstation-selection-performance-readiness-green.log`), with their typechecks exit 0. Independent scoped reviews are PASS after their respective pickup/readiness P2 corrections: `workstation-large-score-independent-review.md` SHA-256 **`0A45E6B6B70B7D4E7A6AC0CE2DC43373E8EC1FA9311F32C5BE9F3E65504E9869`**, and `workstation-selection-performance-independent-review.md` **`39A5E098F526B47BE07DA7B1E9C12B6A22069C8E6D32330B83C1FB57C4D311AE`**. These affected runs follow the earlier 132-file sweep; no fresh whole-suite pass after every correction is implied.

The normal CSS/fixture/tuning and driver scope has independent PASS review **`C2E52A30D86F880DCD9E20B34DC4264BBCAE92AFCEF3473375D2E95B7854C6DE`** (`workstation-final-scoped-review.md`). Its corrected driver SHA-256 is **`407C3ECBCDBB7EC4A8E5AC7B575EA41AE5236F1F9A37DDB5CB1E221244519C21`**. The long assertion now derives its cap from the viewport's 28-pixel rows/cells, 144-pixel name column, two-cell overscan and one retained offscreen focused cell, rather than allowing nearly the whole 32×2000 grid. This source/test-strength correction is distinct from the older normal driver hash and its accepted captures.

## One material-fix batch and confirmation

Root opened each of the original six workstation images once, using prefix `workstation-1792076631662-a713340c-4b44-4492-bc6f-1f1197b088fa-` under `.analysis/desktop-smoke`. That inspection identified three material CSS defects. Root applied one correction batch in `workstation-shell.css` only:

| Defect | RED measurement | Final correction / GREEN measurement |
|---|---|---|
| Inspector horizontal overflow and competing scroll containers | Fixed inner width 272px, padding 16px, `overflow:auto`, outer client 268px / scroll 272px | Fluid full width, padding 8px, inner overflow visible, outer owns scrolling; outer and inner client/scroll all 268px. Sticky context header remains readable. |
| More playback covered its visible error | Feedback bottom 122.546875px; overlay top 105px | Position below the transport's actual height (`top:100%`); overlay top 128.546875px. |
| Narrow rail split Inspector across lines | Anywhere wrapping inside the fixed 48px rail | No wrapping, zero inline button padding, tracking −.02em; final capture assertions report one line and client/scroll both 41px for every rail label. |

Measurements: `.analysis/parity/workstation-geometry-red.json` → `.analysis/parity/workstation-geometry-green.json`. Root opened the three affected confirmation images once and reported the Inspector header readable, rail labels on one line, and error visible. The confirmation reran the normal batch on its recorded executable and structurally checked all six captures; unaffected states were not subjected to another visual-polish loop. Later performance corrections do not imply a repeated visual batch.

Existing realistic instrument artwork, note mapping, compact local scrolling and Expand behavior were intentionally retained. At 960 × 720 the instrument content is 191px within a 129px locally scrollable live-view viewport. Shrinking the guitar to eliminate that scroll would reduce readable fret/note positions. This is documented local scrolling, not a claim that the full instrument body is visible at once. Mixer horizontal scrolling also stays inside the dock; pane scrolling preserves the score's working area and the 960px floor.

## Final capture matrix

All files below are under `.analysis/desktop-smoke/` and share prefix `workstation-1792077539539-a6e2e38f-4cac-4e50-af0d-11f75871413e-`. The final JSON carries their exact paths, hashes and geometry. Every captured body width equals its viewport width; real notation SVGs are present and paper width is positive.

| Capture suffix | Viewport | Paper width | SHA-256 |
|---|---|---|---|
| `playback-error-960.png` | 960 × 720 | 597px | `8d73c17596b36832636d3fc22f912c495d8f9d14ad237c51eb4622e18c563378` |
| `overview-1280.png` | 1280 × 900 | 765px | `5f23357bc65284fed02bc5b5af8c323e8e0249f757db3f47af7addb23a452e38` |
| `mixer-1600.png` | 1600 × 1000 | 1041px | `76ca4ea72da783955f5ea99785ce500d0dff3094b72aa34a23cf58aeaba3e6db` |
| `sound-960.png` | 960 × 720 | 597px | `39c51d4c45915856d1b2dcf83acd0163906dcb3e6b8f714e9f8e84d94524685a` |
| `instrument-960.png` | 960 × 720 | 597px | `4981bb5997794857354706843204646bee706aa563c97c1c1de65d69e30352d3` |
| `inspector-expanded-1280.png` | 1280 × 900 | 765px | `e3d4206ca5514b02bac093a37c47623fab7c48ebd26123d24bf6897b6bfb2bd7` |

## Related acceptance and remaining gates

Root also completed and inspected the separate nine-PNG recovery/export visual group. Crosslink only: `docs/validation/2026-10-15-gp8-recovery-session.md` and `.analysis/desktop-smoke/recovery-acceptance-1792077636801-d941a729-d5a1-4226-af99-1694bd8f24dd-visual-result.json`. Those receipts own recovery Retry/failure/durable-session conclusions; this workstation report does not re-certify them.

Four future Library concepts (Recent, Templates, Folders, Examples) were generated, saved and design-reviewed; their provenance is `docs/design/reference-workstation/library-generated-concepts.json`. This is preparation only and supplies no Library implementation or runtime acceptance claim.

The joined independent review **`.analysis/parity/workstation-joined-final-review.md`**, SHA-256 **`3DCE39D8CC6E807E232B6432F4F6B2233E3E4147122A9005F1FCC8CB9D26BBA4`**, now records **PASS, with no open P1/P2**. Its sole P2 concerned retained playback after successful shutdown followed by failed window destruction, including snapshot-only retry after native resume had already succeeded. The frontend correction remembers native resume acknowledgement, keeps the workspace reserved until synchronization succeeds, advances one transient playback-resume epoch, and refreshes the retained player from native generation/desired-generation floor initially stopped. It preserves exact live music/history/redo/views, one App/player, and strict stale owner/generation checks. The transient epoch is not saved music/recovery state.

The review verifies meaningful REDs, the mounted real-controller failure/resume path and delayed/stale completion cases. The accepted correction report is `.analysis/parity/recovery-resume-playback-report.md`, SHA-256 **`9DBDDEDC776B4789347CE88F783601A903ADA9562A430E69C9A6B925BFF82082`**. Final production postimage identities are:

| Source | SHA-256 |
|---|---|
| `src/App.tsx` | `E9496A6C9F6B84491086F2E63F552D1C52CF69EB8E5451A654FE0087A72651C5` |
| `src/audio/NativePlaybackController.ts` | `DEC493B67247FDDE2BBFBA91E52DD1FA7E97A040E728A710DC76C31BB33F310A` |
| `src/workspace/WorkspaceController.ts` | `9407EBED4F8B9C7F5831ACE2B38C84150D5EF43B1BED11F553F66032BE180CFF` |
| `src/workspace/WorkspaceApp.tsx` | `8B86AAD1435F9BEA4807578ADF66950235A072534D4381A07612824BA8033375` |

Final executable SHA-256 is **`8A8CB8B4D5572CCD47D935B08006B024AA0DB2102AA7FD8323C319B3487780FE`**. `.analysis/parity/recovery-workstation-resume-final-desktop-build.log` records successful frontend TypeScript/Vite and Rust 1.88 release build (39.19 s), retaining the chunk warning. The actual bounded normal `--backing` run exits 0 in `.analysis/parity/recovery-workstation-resume-final-normal.log`; result `.analysis/desktop-smoke/workstation-1792081585534-12dd183e-fe70-424b-b675-97b5f0544e1a-result.json`, SHA-256 **`86BA2660B5BD3E68D678818E57D13FF0A357D5C10743265452EF859C091139A8`**, completes exactly **12 groups**. Options are `long:false`, `backing:true`, `captures:false`; final native status is generation/desired generation 12, Ready/stopped at tick zero, phase idle, backing duration eight seconds, no error, with no page errors. This run adds no PNG or physical audio capture and does not repeat Long.

Root's final bounded host-exception attempt **does not establish actual shutdown/resume acceptance**. `.analysis/parity/recovery-resume-desktop-final-run.log` exits **1** because pinned `8A8CB8B4…` exposes an immutable outer `window.__TAURI_INTERNALS__` property. The driver's explicit guard fails **before fault installation, WM_CLOSE, native shutdown or resume**. This is an unsupported host-injection mechanism, not a product failure or a failing execution of the corrected resume path. Root terminated only captured application **PID 34840 / UTC start ticks 639276787342763360**, with executable/start verification, and retained isolated `resume-session-GFMwGP` and `profile-1792081933869` diagnostics.

The driver packet has static scoped PASS review `.analysis/parity/recovery-resume-desktop-script-review.md`, SHA-256 **`B9FF8091E691E3F6FA69779984C7DD2DE16F4745B44FF064262717BC74DED0DB`**, source SHA-256 **`D0E5E93E3E4C24E951CBA43587E2E7244A1CA3173143C188D22FE825A691C204`**; its view-preservation coverage was corrected before execution. Source review is distinct from runtime support. The accepted resume fix rests on real-controller/mounted/native-floor regressions (**213 affected passed / one incumbent skip**), the cohesive **342-pass** affected run, joined PASS review and final build/normal 12-group receipt. No actual JavaScript destruction exception or true OS destruction failure is claimed. Root records source committed locally at **`26a9ddb`**; the later verified push and CI checkpoint are appended below.

The actual selection gesture gate now **passes on the recorded `4D1A1404…` executable**, before the resume correction. `.analysis/parity/recovery-workstation-selection-gestures-3.log` and `.analysis/desktop-smoke/selection-gesture-1792080973426-57372-result.json` (SHA-256 **`2D210F31526396B6F7557265A2746D99FABCD8708488F416AE2A1A4E0CB562C2`**) retain four real native UI checks at **115% zoom / all tracks**: sparse second occurrence **8640–11520**, a non-autoplay bounding loop **960–3840**, dragged passage **960–2880**, and resized passage **960–3840**. Generation remains **10**; complete project/history including redo and source bytes remain unchanged, and page errors are empty. Authored source GP SHA-256 is `74c0832d96cf49a874f847629522d53a800117bee314c18e905f46b2251d5ad5`.

Root opened the single 1280px screenshot once and confirmed nonblank readable selection and contained More playback controls. PNG SHA-256: **`7DAF58F008E05EC3FABF0156DA7DEC622EB2FC0A8BD702376A7B03A060AB729F`**. Driver SHA-256 is **`CBD7B1E71D1D2A4DE8911CEF5E210B443102742628A8F09509622F2038F77E58`**. Its corrections change presentation entry only: actual Escape dismisses More before SVG/Inspector work, and occurrence entry opens both inner/outer disclosures. The first two attempts remain unsuccessful receipts (More intercepted Edit; inner disclosure remained closed); no product assertions were weakened or native musical defect inferred. This passing gesture run remains explicitly at the pre-resume-correction `4D1A1404…` stage and performs no new physical audio capture.

Open gates at freeze:

- Actual desktop destruction-exception acceptance remains unavailable: the one bounded attempt stopped at its immutable-host guard before native close. Its scope is a recorded validation limitation; mounted regressions and the final normal run are not relabeled as executing that path.
- Final evidence disposition retains the earlier long/gesture runs at `4D1A1404…`, the normal visual run at `5E8EBF4E…`, and final normal run at `8A8CB8B4…`; no later Long/gesture/visual rerun is implied.
- Source delivery is now verified as recorded below; full goal completion and current all-OS CI acceptance are not claimed by this report.

D04 remains a written-measure navigation slice, without reorder, drag selection or repeat-expanded timeline. D05 remains show/hide/responsive switching without draggable or persisted panel widths. P15 remains missing: waveform/grid, audio timeline and visual drag-sync editing are absent; backing import and numeric anchors remain separate P13/P14 foundations. No fabricated waveform, meter, pedal or recording control closes those inventory rows. Original GP8 runtime equivalence, cross-platform native runtime equivalence, PCM fidelity and physical audio quality were not established by this Windows diagnostic batch. Earlier physical captures remain separate evidence and were not repeated.

## Accepted source delivery and CI checkpoint

Root reports accepted source 26a9ddb plus documentation 1f85ce2 pushed to feature branch feat/gp8-parity, with the remote ref verified at 1f85ce2ef90f2fa1940aa998490a5e7308de74fe. Main remains 7fc41c773a1b016d7249ceb98ab7929fcca1ce8f. This records that accepted checkpoint before the in-flight Library/schema3 implementation; later work is not certified by these receipts.

Root reports GitHub Actions run 38770187771 at exact head 1f85ce2ef90f2fa1940aa998490a5e7308de74fe completed with FAILURE before any prepare-audio steps; desktop jobs were skipped. The job-log request returned 404 and the cause is unknown; no billing or other cause is inferred. This is not a current all-OS PASS. Earlier W05 run 38738258294 passed all OS jobs at 64a1e8f7e416b93ca624a3c48196984424f4a28b only, and remains historical evidence for that source. This documentation adoption ran no Git or network command and relies on the root-supplied delivery/CI receipts.
