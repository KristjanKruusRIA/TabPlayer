# Guitar Pro 8 document tabs — validation

Observed 2026-10-15. **The bounded W05 implementation and Windows native acceptance pass.** The complete document-tabs workflow, corrected Unicode PDF export, physical A→B→A output and final native window close have separate receipts below. Independent final re-review closes the sole P2 lifecycle finding with no material residual finding. Git delivery is recorded separately and remains pending at this checkpoint.

## Scope and source identity

The [design](../superpowers/specs/2026-10-15-gp8-document-tabs-design.md) and [plan](../superpowers/plans/2026-10-15-gp8-document-tabs.md) define isolated native histories, addressed save/export operations, per-tab views, shared music clipboard, one active audio owner and transactional close decisions. Schema 2, alphaTab 1.8.4 and Rust 1.88 remain the reference versions. Live sessions retain redo/backing assets; ordinary saved files intentionally compact unapplied redo and unused assets.

Root's recorded HEAD is `32b6fefc07588533ba0878b38a7122355a685ddc`; the earlier remote is `f6350fc3e1bb33e1e63c7d81524c87e0df61c8de`. The complete product/test review artifact `task-8-final-review-2.json` has SHA-256 `ca56517b490254d423b45b8e414aacbae4d28d5ecea863ad7c94fafe4f2eb687`. Final artifact **`task-8-final-review-3.json`**, SHA-256 **`e829ab1950bcdb715c521c2bcdf0bcc0f4d1f0ac1bef5c3791eca3590cadb5f4`**, incorporates the three-file lifecycle correction. The independent reviewer verified all 120 live-file hashes and the complete artifact comparison. SDD `task-8-final-review.md` records final spec PASS / quality acceptable with the P2 closed.

Local evidence is retained under `.superpowers/sdd/2026-10-15-gp8-document-tabs/` (**SDD**), `.analysis/desktop-smoke/` (**smoke**) and `.analysis/parity/` (**parity**). Ignored diagnostics are not published package contents. **Git delivery: pending root's explicit commit(s), push and verified remote SHA.**

## Complete Windows workflow and Unicode PDF

The font-corrected diagnostic executable SHA-256 is **`3f640bb7fd3c927b137abe387a2d558c1c7e1069e3eb12f9c3edb5036c7fd966`**. It predates only the final window-close lifecycle correction. Smoke receipt **`document-tabs-1792068304726-df4e0792-e6f4-4cd4-b148-0ff8ad308485-result.json`** reports `passed:true` with **24 checks** complete; receipt SHA-256 `60c9f11f6cfa57d662246230324a71b54811355a31f928de6c90b28ee47d0550`. SDD `task-8-native-tabs-font-corrected.log` retains console output.

The checks cover independent dirty histories/views; duplicate-path intake; cross-document phrase paste and undo/redo; keyboard/panel behavior; stale A→B→A ownership rejection; inactive addressed save, destination and redo-only backing protection; real Save As cancellation; **MIDI, PDF, mixed WAV, WAV stems and GP exports**; inactive export rejection; export busy/cancel; Close All Discard-then-Cancel and Save-then-Cancel; inactive, active/last and Discard-all closes; fresh-process schema-1/schema-2 reopen; absent ordinary disk redo; and inactive backing export protection. The successful script verifies retained source hashes. It explicitly records physical and visual capture as unrequested/unperformed, retaining the earlier accepted phases instead of repeating them.

An earlier attempt exposed a real strict PDF failure for the unchanged title “Öölaul — 同じ楽譜 🎸 · A very long independently authored document title for horizontal score tab overflow”. The repair bundles official pinned **Noto Sans CJK JP** and outline **Noto Emoji** assets, totaling **18,450,332 bytes**, with complete OFL licenses and provenance in `assets/fonts/sources.json`. Noto Sans and Bravura remain unchanged; font loading uses bundled bytes without system-font discovery.

The repair also vendors pinned `usvg` **0.45.1**: 39 original upstream files (about 637 KB), with exact provenance/licenses/patch notes under `vendor/usvg/`. Only `src/text/layout.rs` changes executable upstream behavior. Fallback matches original UTF-8 source clusters rather than glyph positions, preserves resolved primary glyphs/ligatures, and rejects incompatible or unresolved fallback. Strict conversion, vector output, resource denial/checks and cancellation remain enforced. Parity `pdf-unicode-fix-report.md` records **8 native PDF tests, 7 dependency cluster tests and 74 scoped frontend tests passing**, with meaningful RED receipts and exact mixed-title coverage.

Root's header measurement fits long titles within the existing printable width, retaining the short-title 18 CSS-pixel size and notation capacity. The actual two-page score PDF SHA-256 is **`0a5267ab863a6a1c24fefd23043e8ede521a67aedd6ce0d3f664247ff9fa9f55`**. Parity `task-8-actual-pdf-inspection.json` confirms the exact Unicode title on both pages and three embedded text fonts (Noto Sans, CJK JP, Emoji). Its header size is **10.0989 pt**, with right bound **552.0065878816035 pt ≤ 552.75591496063 pt** printable right. Root inspected both Poppler-rendered pages. Strict vector export remains in force without SVG image substitution.

Representative successful output hashes: GP `61a7288220d0db9beeae4576e739f74526be2c5451cfd871cd9302d6a470d9de`, MIDI `c32ec220212c98f6f2b6dc16a93a0242ddcf7ee76b7315fcdc6d97dca79f57ea`, mixed WAV `077e4c9a3c324d57e8ce856270fa811660eeec0b84eb1165c10d09fd330da320`, stem manifest `40c214e47d67c87dfcd7d662eb07c55b80d776172497011eb2bb9009d5d007f4`. The receipt retains the complete input/output inventory.

## Retained physical audio and viewport evidence

The earlier diagnostic executable SHA-256 is **`bce2740693c1d57ad98becb395af21e4294c8c55ef1560b3560a5214b8dce3b2`**. Its first-run receipt `document-tabs-first-run-1792065672206.json` verifies startup → fret-7 edit → second tab → first-tab reactivation with exact retained revision/history and zero page errors. SDD `task-8-native-cancellation-green.log` separately records real Open/Save picker cancellation and native dirty Close score → Cancel preserving snapshot, revision and active owner.

Physical prefix **`document-tabs-1792066445430-f5dda581-a9ae-48cd-a69b-f9c6da4f9784`** completed five captures on **Speakers (Pebble V3), 48,000 Hz WASAPI output loopback**, without microphone input. Its later UI locator timeout leaves the overall `-failure.json` at `passed:false`; the completed physical phase is separately supported. Literal identity checks pass for A MIDI 60 / 261.625565 Hz with 173 Hz backing, B MIDI 67 / 391.995436 Hz with 293 Hz backing, then A again. Both stopped captures have exact RMS/peak zero and no autoplay; all samples are finite.

| Capture | Frames | RMS | Peak | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| A first | 144000 | 0.0416685748441 | 0.188709229231 | `6f45d4b3a40d1913e374856514307b084f594a8178cbada34ead83deeb41a9d8` |
| A→B stopped | 144480 | 0 | 0 | `90b9ea5fc23fca7785cd22267fbf5d82dfd4a3ba657c9005f24869f99c612be0` |
| B | 144000 | 0.0341371172037 | 0.133975580335 | `2acf8d0764c9ef5d446d7e7978481720360c668b296e570e0beea2c6257fb1f3` |
| Reactivate A stopped | 144000 | 0 | 0 | `626719a49b122fc68b0ec3b13f4f6a724c05f6839e9df2ab442213318cf5eafd` |
| A replay | 144000 | 0.0417281691904 | 0.188709229231 | `369e4f77682b6db5d8fdfc8a3d02b74cb7ca740d757eb074e08022793916cee1` |

The receipt contains separate intended/other score and backing band measurements; aggregate frequency estimates are not substituted for these identity checks. Root told the user the physical phase was finished and audio use could resume. These measurements establish the captured Windows intervals, not universal device timing or physical behavior on another platform.

Root inspected the accepted 960/1280/1600 screenshot batch under prefix **`document-tabs-1792066897002-e41121c7-038e-4375-9564-2891cb678051`**, also from the earlier executable. Three columns and the physical instrument remain intact; tab overflow is contained (scroll width 1876), with body width equal to viewport. Screenshot hashes respectively: `98a9c89eace42a3a63c6414b520fe5ccc6802865fa3b51aac51b716aa56b61f0`, `04ec363eff70d7038e31d9d2f06cb79c1de4d980829d94bf43b364da007de771`, `ecf2d5e34f665ac835931806d2cef03fcf536bcfcd6c65663405025803f1b1ef`. That run later failed at PDF; the successful retry transparently used UI-only/skip-visuals flags.

## Joined verification and final lifecycle correction

Tasks 1–7 have scoped independent Spec/quality PASS records in SDD. They cover strict addresses/revisions, native session/source protection, accessible tabs, all nine restored intake coverage groups, views/clipboard, exact audio ownership, export leases/cancellation and keyed single-editor integration. Native synchronization proves current-owner Invalidate overtakes a latched prepare, followed by transition floor 101 and old-owner rejection; physical evidence is separate above.

Before the final three-file frontend lifecycle correction, root's joined checks passed:

| Check | Result | SDD receipt |
| --- | --- | --- |
| Full frontend | **121 files; 1672 passed / one incumbent benchmark skip**, 82.14 s | `task-8-joined-frontend.log` |
| TypeScript | Exit 0 | `task-8-joined-types.log` |
| Resource/package contracts | 10 passed, no skips | `task-8-joined-resources.log` |
| Rust all targets, 1.88 | **254 passed / 6 explicit ignores across 22 result suites** | `task-8-joined-native.log` |
| Rust formatting | Exit 0 | `task-8-joined-fmt-final.log` |

The complete immutable review found one **P2**: successful window close published the native replacement blank and cleared busy before deferred destruction completed, permitting a new App/player and document actions. The correction retains the mounted editor and transition reservation until destruction. On destruction failure it refreshes the already-committed native workspace before resuming; failed refresh retains the blocked editor and reports the errors. Ordinary Close All still publishes its blank normally.

Parity `task-8-window-close-fix-report.md` records mounted main/real React root/WorkspaceApp/App/player regression coverage. The retained baseline RED fails on the replaced App and accepted New during deferred destruction; after correction **45/45 affected tests pass** in two files, with TypeScript exit 0. Cases cover success, destruction rejection, snapshot rejection, cancel and native-close failure. Native bridges are controlled doubles and only ScoreView canvas rendering is stubbed. **The full frontend suite was not rerun after this correction**; the affected 45-test slice and types were rerun. Native code did not change. Final independent re-review verified artifact 3 and closed the finding. An unsuccessful exploratory attempt to replace immutable Tauri invoke was a harness limitation, not a native RED or acceptance receipt.

The final diagnostic executable SHA-256 is **`dcf69fbe39c03d4c99b88e10ea9a7ded5e6180430e641eb8983f134f5a78349a`**. SDD `task-8-desktop-build-window-close.log` records the Rust release rebuild completing in 38.11 s. Smoke **`document-window-close-native-1792068694838.json`** reports `passed:true`, PID 49772, zero page errors, production Windows **WM_CLOSE → dirty Cancel** preserving the exact workspace, followed by **WM_CLOSE → Discard** closing the page and exiting the owned process naturally. Parity `probe-tabs-window-close-native.mjs` and parity `task-8-window-close-native-green.log` retain the probe and 5.408 s result. No owned application remains. This actual close receipt complements the mounted tests' controlled deferred-success/failure lifecycle proof; it does not claim a real OS destruction failure was induced.

## Limits

The [historical cross-platform CI record](2026-10-15-gp8-selection-stylesheet-ci.md) applies to earlier remote `f6350fc`, not W05. The original 258-row inventory and overlay remain unchanged. This bounded validation does not establish complete GP8 parity, original Guitar Pro runtime equivalence, arbitrary Unicode/emoji support, W10/W11 recovery/session restore, physical macOS/Linux audio, native printing/installer lifecycle, signing or a new main release.
