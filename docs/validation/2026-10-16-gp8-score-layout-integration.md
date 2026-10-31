# Interactive score layouts: source validation

2026-10-16. Accepted source: `6033f0508459dd54ac45104565eb871b824d581c`, following initial integration `f6b054811e89f0b6b6d23f4c5f494fb304d867c4`. Review base: `198e8c5e365644ac5ab1116fe3634988cdee9c94`. This validates the frontend source integration. Actual Windows ink, gestures, paused native presentation, recovery and performance remain the separate desktop acceptance gate; D01/D02 and the overall parity assessment are not promoted here.

## Result and scope

The existing score toolbar now offers Vertical page, Horizontal page, Grid, Parchment, Vertical screen and Horizontal screen. Physical modes share whole-system pagination with equal cream sheets and 24 display-pixel gaps. Endless modes use the public live renderer. Manual fractional 25–300% remains separate from Fit width and physical-only Fit page; unavailable and limited fits have explicit feedback. Old views retain their omitted optional preference and resolve to Parchment/manual.

App retains the existing view bridge. Derived zoom/resize metrics stay local. ScoreView keeps one API, updates settings/rendering for layout changes, maps physical note/range interactions through accepted immutable geometry and canonical score identity, and preserves the existing native playback controller. A narrow public presentation adapter maps the clock-derived cursors, scrolling and supplied opaque glyph-highlight IDs; it adds no output clock, native command, dependency patch or private ID derivation. Oversized paper content falls back explicitly to continuous notation at the last manual magnification.

All six actual GenAI reference/provenance pairs were inspected and committed before UI implementation. The selected composition authority is `docs/design/reference-workstation/score-layout-reference-selection.md`, SHA-256 `A7496A5CE490AC2D093E97F9E0013F7678FE106FFFAFC6EE4ABF52FB0C6E5539`. Raster notation errors, unequal paper, incidental labels and overlap were excluded explicitly. These references are generated concepts, not screenshots of the application.

## Independent review and corrections

The single joined source/spec-quality review covered the coupled App/toolbar and ScoreView/adapter patch. Initial report `.analysis/parity/score-layout-integration-independent-review.md`, SHA-256 `FDC1A22AE976BBB1C22C12EA486D4E7B0318F4FC218EA2915A11BF10AA341378`, blocked on two Important findings:

- I1: Horizontal screen's transparent full-width canvas overflowed the fixed cream input wrapper. One scoped CSS rule now paints the actual full canvas with the existing paper token, independently of renderer input width.
- I2: a same-system bar callback discarded the mapped beat before the separately queued transition. One adapter condition now retains its valid interval/elapsed continuation until the new transition, while preserving render/system cancellation and stale-callback rejection.

Both received behavioral failing-before/passing-after regressions. The one scoped correction review `.analysis/parity/score-layout-integration-fix-1-review.md`, SHA-256 `251B9FAA12365DD86C0500AE36F422F31FC29805716BFA704886E08F36367F59`, resolves I1/I2 and passes spec/quality with no source blocker remaining. Neither review claims desktop pixels, actual animation timing or physical audio. The initial report is preserved unchanged.

## Verification

Root checks ran in the authoritative feature worktree. Commands invoked Vitest directly; npm pretest/fixture fetching, builds, native suites, apps and physical playback were not invoked.

| Check | Source and result | Retained log SHA-256 |
|---|---|---|
| Joined focused eight files | Initial integration `f6b0548`: 283 passed, 46.06s, exit 0 | `AA34FBB65B7615D28772D88E217F34940183FA8BFBEF328BFEF5AE99443C1F25` |
| Corrected core six files | Correction: 155 passed, 2.79s, exit 0 | `1AC26142191CBE2E5B2950422691FB68D81C78036C3DFEC3D4F74C1E999F00B1` |
| Typecheck | `npm run typecheck`, exit 0 | `EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6` |
| Full current frontend | `npx vitest run --maxWorkers=2 --reporter=dot` at `6033f05`: 172 files, 2,809 passed / 1 skipped, 122.39s, exit 0 | `B9700B7A7BA9D0F1460EDF7982EDCBEFA7F99064D8C9A25BC7BA6962A5A81078` |

Logs and producer reports are retained under `.superpowers/sdd/2026-10-16-gp8-score-layout-integration/`. Root source receipt is `.analysis/parity/score-layout-source-verification-root.json`. The full run retains dependency diagnostics from deliberately rejected malformed/corrupt import cases and existing timing/preservation output; it is not described as silent or pristine. The skipped test supplies no coverage claim. Older frontend/native totals are not substituted for this run.

Task1 report `90C1902D6B52227B94D4C3B0A0F2D58F0048C6C23C994744A11608ED94A5F888` records six expected preproduction failures and final 133 tests. Its RED shell wrapper did not preserve the command exit code; the retained Vitest failure summary is evidence, not a captured shell-exit assertion. Task2 report `A4E984E381C12CD6D3B29601D7533D0A542B2FF34F5D4DE41024598BC13769B8` records initial meaningful adapter/layout failures plus fit/readiness, remount and animation regressions. Fix report `0B0DB34257B150840AB8DFB01E819D7D0D53D0BB4592FBF372A7167FA56FDC33` records separate I1/I2 behavioral REDs, explicit exit codes and final 155-test producer verification. Root removed only two new EOF blank lines after the corrected focused/type checks; the subsequent full suite ran on the committed final bytes.

The real headless oracle uses installed AlphaTabApi, BrowserUiFacade, renderer and fake-handler external-media callbacks, with Audio/AudioContext construction forbidden and no app/native controller imported. Original source DOM supplies the opaque-group oracle. It verifies two simultaneous track groups, publication replay and an old real queued callback rejected after rerender. Additional actual-renderer component cases verify the wider horizontal canvas background selector at manual 100% and lower-limit fit 25%. Synthetic layout/text/font metrics and literal substitution of the production paper-token fallback for jsdom constrain these to source/seam evidence. They do not establish browser ink or physical playback; no independent IPC spy is claimed.

## Frozen production inputs

| Path | SHA-256 |
|---|---|
| `src/App.tsx` | `AF0150DF091EA8104CBC551D62E95B8572DDE019594087042A76A1CE034DD8EC` |
| `src/engraving/TrackDisplayControls.tsx` | `9BA889C0D4B564A0AEFBE55E85C72E01D183D19A29299B0FFE24EA1FE36CEC7D` |
| `src/workstation/workstation-shell.css` | `55E3BA6C888CD5EE48B49C34F23EA9BCE69C0A6BB0B3AC92A736DEDB031DC0E6` |
| `src/ScoreView.tsx` | `29429076B94156755E7C50771B37D7D2CAC3B2A2B0AD9AD958492C8CF6F8EB1A` |
| `src/ScoreView.css` | `5C2B5A5E7A7F045A8E944482C3B113AED26ED95D561A1E30E951D9EA47D05C00` |
| `src/engraving/screen-playback.ts` | `B41F5C277AA5B9F11F3FED0E324BEF4B79D1A9EDB2D9E7039B3F33CDBB57F4DA` |
| Accepted preference contract `src/engraving/screen-view.ts` | `C81CB0CC0168BE467EF333F967DC7D5123F9567C9196E862EE15CA04A9F01F28` |
| Accepted geometry contract `src/engraving/screen-pages.ts` | `43FEE7EBA7783F92A218C72DE344A094021E3BD908ED185BEE23375662E99E80` |

The accepted contracts and native/controller source were not changed. The root receipt binds all twelve integration source/test paths; final actual-test hash is `4CA3552B93EA8692A62F50E26940A04B95B0F5E8F3EA2BAB7B7FF77B9EB888AE` after the disclosed EOF cleanup.

## Desktop handoff and limits

`docs/superpowers/plans/2026-10-16-gp8-score-layout-desktop-acceptance.md` prepares fresh authored multitrack/voice input, independent actual-note SVG/CTM pointer coordinates and native acknowledged identity/range receipts, view-only transport/history checks, paused seeks, real recovery and measured performance. Separate source owners may implement the fixture/observer and driver against fixed interfaces; root owns their joined review, unique diagnostic build, fresh source/EXE/resource admission and exact-instance lifecycle. Planning grants no runtime admission.

Actual visual acceptance remains exactly one initial batch of twelve frames (six modes at 1600×1000 and 1024×600), with at most one combined correction/confirmation. No older P16/P17/P18 visual cycle is reopened. Real font/ink, pointer/keyboard gestures, scrolling/dock geometry, native repeated-order stationary cursors, restored per-document state and representative eager-DOM cost remain unproven until that gate. No actual Play, device, listening or recording is authorized. GP8 runtime equivalence, macOS/Linux runtime, installer/shipping, physical audio and full parity remain outside this source result. The existing 78/95/77/8 parity overlay remains unchanged. No current-head CI result is asserted.
