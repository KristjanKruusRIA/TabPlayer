# GP8 backing waveform and visual synchronization — validation checkpoint

2026-10-15. **Tasks 1–6 are accepted in source; joined checks, two actual Windows runs and visual acceptance pass.** Final Task 7 adoption, joined review and delivery are tracked separately in the linked plan and parity overlay. This evidence document makes no remote-delivery or broader parity-completion claim. Both immutable successful runtime receipts retain `task7Complete:false`; root retains final acceptance authority.

## Scope and reference

The [accepted design](../superpowers/specs/2026-10-15-gp8-backing-waveform-design.md) and [plan](../superpowers/plans/2026-10-15-gp8-backing-waveform.md) define a native read-only waveform query, true per-channel peaks, performed bar/beat grid, source-time ruler, score-selection matching, zoom/pan and reversible visual sync-point editing in the existing Backing dock. Existing numeric editing, gain units, document ownership, source/history and native audio clock remain the authority. Viewing, marker selection, zoom and pan do not edit music or transport.

The query uses the exact logical envelope `backing_waveform {request:{owner,document,source,buckets}}`, strict nested DTOs, current owner/revision/applied-source admission and one independent waveform work gate. It captures shared encoded bytes under a short workspace lock, then decodes/reduces outside workspace and audio locks, rechecking identity before decode and publication. Original embedded viewing binds the native file-base digest and independently hashes the frontend-supplied audio bytes without staging an asset. This is not independent native proof that those bytes were extracted from the GP archive.

The new query-only ceiling is **512 MiB of raw encoded audio-container bytes after base64 decoding**, with predecode text/padding checks and a postdecode actual-byte check. Output is bounded to **8192 buckets**; the UI requests 8192. This does not impose a universal backing-import limit, bound decoded PCM heap, or make the incumbent full decoder streaming or cancellable. An in-progress obsolete decode may finish, after which publication is rejected.

Root generated, versioned and inspected the actual GenAI reference before UI implementation. The view adopts its compact filename/zoom row, violet waveform, source ruler, real measure/occurrence grid, handles and compact readout. Existing adaptive dock height, boundary before Inspector, numeric controls and gain units take precedence over incidental generated geometry, labels and time relationships.

| Artifact | SHA-256 |
|---|---|
| `docs/superpowers/specs/2026-10-15-gp8-backing-waveform-design.md` | `6E2FB1FC5FF062E8BED0F870199A8CC5D062289B8ECE875F633008F2F0E6FE31` |
| `backing-waveform-concept.png` (removed before publication) | `D19D16955B14E9DCB6A1958D35F70E4CFF6C8FFCB11900CDA189954674E6D576` |
| `backing-waveform-generated-concept.json` (removed before publication) | `67E9B9E86BBA9F1D875353398B9DDE79AF554ACD0C6E0B109529E7198E2F24EC` |

## Accepted source and independent review

Root records contract commit `de06de21ac60a9b9c5ea7ab61d6abafd2ff36535`, Tasks 2–5 source `02c8b05`, and joined Task 6 source **`8bbd56ced2219e03c94a2d3d840fd215fef01d59`**. The build receipt identifies that final product source. This documentation worker did not run Git or independently certify a push/remote ref.

The native reducer retains every frame's extrema and opposite stereo polarity, including boundary/final impulses; mono draws one lane. Pure projection integrates full tempo segments and performed occurrences through existing BackingMap semantics. Visible source position is stored anchor audio time minus offset; movement stores source position plus offset and rejects crossed neighbors. One completed-source hook cache avoids clock-driven decode/encoding, suppresses obsolete responses and guards deferred dispatch after hide/unmount. Pointer and keyboard previews use the existing operation lease and commit one changed `setBacking`; cancellation/no-op paths preserve history. Current generated timing remains readable after output-device failure, with an explicit subscriber notification after preparation releases.

Current product source fingerprints were recomputed for this checkpoint:

| Artifact | SHA-256 |
|---|---|
| `src-tauri/src/audio/waveform.rs` | `83C53E0C87AEDE1E6334383D2C88E5F98B1B12F7E7A804623A49D3A315E0E7AD` |
| `src-tauri/src/backing_waveform.rs` | `A8683876E9F694DD8E0BFD7FE93BC1757F450DE879995A09803EB37BB4CBBC91` |
| `src/audio/backing-timeline.ts` | `2740AF46BB9B036EAC241F4B7F06EC17BBA7031E9A3FB05649D02AFAC1307F8B` |
| `src/audio/backing-waveform-bridge.ts` | `42830A74B90E9F56B0055687C3F2D9FE6335A76326643269417075701A85C1CD` |
| `src/audio/useBackingWaveform.ts` | `47342BD762A9333CC8DA4EE85B5DABC8D5C467EFBE71D10483949337C5D0FE5B` |
| `src/audio/BackingWaveform.tsx` | `A60E4A0A4A2FC7D402ED823EA7C500E170AB5632A0334439FEA4381A9B3DE852` |
| `src/audio/backing-waveform.css` | `629AED9D0168B10D7E8545B1F7A20BF2E236C3F4C63C42A94E18700CD7DDB293` |
| `src/audio/NativePlaybackController.ts` | `6FF1AB4D980901033911D752B274E228D74ADA205003AE9184071232EB599705` |
| `src/App.tsx` | `352E25431E93E21F38AE0E95C1AE451A7728301CEE8A553B30317E6F64F5D906` |
| `src/workspace/WorkspaceApp.tsx` | `9DEDBA453780F3A6409B772C16E10005BF4EE2D25B244EFFDFE21D2E07636221` |

The scoped reviews below accept their respective source, rather than actual Windows UI or all-OS delivery. The Task 5 review includes the resolved deferred-dispatch race and the byte-proven cosmetic EOF correction; no open P1/P2 source finding remains in those accepted scopes.

| Artifact | SHA-256 |
|---|---|
| `SDD/task-1-review.md` | `18A628ECE16012DD0BA3C9F3EA4EABB40FCE9A585D02364477552D2ACC5CBB88` |
| `SDD/task-2-review.md` | `B3EC39F0C88EE6FE51BA652A72015CA5244CBDC964B78D74DF3A9861A29AD02A` |
| `SDD/task-3-review.md` | `E85EF32D9C0C1291DB62C6E8E1175B1FB7BA872782FBF17515869E11F9EB58CE` |
| `SDD/task-4-review.md` | `F58DDB9E616EBF3169D4E3241DE1CD756A50318B8507B82EAADA524CA6622F4C` |
| `SDD/task-5-review.md` | `3DF47B5AAA1602D451259E15B9A5499AF78F583812121A285841DB42794BDE69` |
| `SDD/task-6-controller-review.md` | `91DA9E818458D6C62EBC461AD36E52AD530A5321B1EB2BCBC51BEA36DE5E8226` |
| `SDD/task-6-app-review.md` | `6C48ED55AF64A86970B0368D104EC8103E2B0CF7A7EAB4263900C45F77B95414` |
| `SDD/task-6-report.md` | `D28DFC817AF2C8BFA1492B7C624B525CA542783E7A411F2B86098F273C9941A5` |

`SDD` means `.superpowers/sdd/2026-10-15-gp8-backing-waveform/`. Detailed focused RED/GREEN and source packets remain there; overlapping focused and full-suite totals are not summed.

## Joined verification and build

| Check | Observed result |
|---|---|
| Full frontend | `npx vitest run --maxWorkers=2 --testTimeout=15000`: **2175 passed, 1 existing skip, 149 files**, exit 0 |
| Full native | `cargo +1.88.0 test --locked --manifest-path src-tauri/Cargo.toml`: **540 passed, 9 existing ignored, 37 suite outputs**, exit 0 |
| Resource scripts | **24 passed, 2 Windows file-symlink privilege skips**, exit 0 |
| TypeScript / Rust formatting | `npm run typecheck` and `cargo +1.88.0 fmt --manifest-path src-tauri/Cargo.toml --check`, exit 0 |
| Production renderer | TypeScript/Vite passed, exit 0 |
| Diagnostic desktop | Release build passed, exit 0; prepared audio and all 16 Library resources verified |

The initial full frontend run retained **2170 passed, 5 failed and 1 existing skip**. All five failures were the existing tuning test's controller mock lacking the new timing readers, reproduced as five focused failures. A one-line mock compatibility correction preserved the musical/history assertions; the focused run then passed 5/5 and the final whole suite passed above. The initial failure log is retained. No physical-audio, Long, old Library/recovery or OLE-drop rerun is implied, and the nine ignored native tests were not replayed.

Diagnostic executable `.analysis/desktop-smoke/tabplayer.exe` is 60,182,016 bytes, SHA-256 **`FE93EB9C4855A0D99F1511DEFC24A673C14D79F25B79753FD5CF601B9C85E803`**. All actual waveform runs below use this executable; the capture correction changes only the driver.

`parity` in this table means `.analysis/parity/`.

| Artifact | SHA-256 |
|---|---|
| `parity/backing-waveform-build-receipt-root.json` | `4F969849D7869DE46B197C05B43C7B695BA0257A7B7E6AE105E709E5DAC468A5` |
| `parity/backing-waveform-production-build-root.log` | `D6AF6744535C387598B8BD16D084ABA03458016B1BAAA7E9D7CA9E0FCC539108` |
| `parity/backing-waveform-desktop-build-root.log` | `D2668CDD98831482D8C5F0F64FEDAC2B97E4E63BDF64F551EAA32FAD66ACFC3E` |
| `parity/backing-waveform-frontend-full-root.log` | `65DDF41B1EAA8FA8FE2103D52B8B3B81ECE28BE4287F6479C765DB7EDF6793D1` |
| `parity/backing-waveform-tuning-mock-red-root.log` | `2C0D6A3993C1449A70032415DF2CFB6DE2332162330D80B9122D2AB78A4BE0D9` |
| `parity/backing-waveform-tuning-mock-green-root.log` | `35713BD399D4B6C3EB986D02D717933533E44405775448C71E01877089E0A081` |
| `parity/backing-waveform-frontend-final-root.log` | `487240E1F2AFF39CFF67F97A0BB1D7828212D47878C6BD161A66C36694CFB1EE` |
| `parity/backing-waveform-native-full-root.log` | `9AF96D567BE799BE7D8D738AA7B0CBC07320850079A6D0E7B4D2153E77CB1846` |
| `parity/backing-waveform-resources-root.log` | `2540A239742B9CAE1FF6A3FC608C588D947FE1FF16B602EE762F8152E3075B94` |
| `parity/backing-waveform-typecheck-root.log` | `EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6` |
| `parity/backing-waveform-fmt-root.log` | `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |

The empty formatting log has the expected empty-file digest; its exit-0 observation is also recorded by the Task 6 report.

## Actual Windows workflow and retained failure

The task-owned fixtures are original authored GP/WAV inputs, including 16-second mono/stereo PCM impulses, repeated measures, 6/8 denominator pulses and an intra-bar tempo change. No private song, vendor score or recording is used. The independent oracle derives exact extrema from authored impulses and literal bucket membership; expected timing/grid positions are literal analytical values rather than output from production projection functions.

The first actual run **failed before Open**, waiting 25 seconds for workspace idle while first-run Welcome still held its legitimate Library operation lease. Its blank clean document, empty `pageErrors` and empty screenshot list establish a driver startup-order failure, not a waveform product failure. Exact owned-process failure cleanup completed, and input/state/source bytes remained unchanged. The old fixture remains preserved. The corrected driver closes actual Welcome before awaiting idle; the startup-only delta was independently reviewed.

A newly prepared fixture `backing-waveform-GLuXRM` then passed with driver SHA-256 **`70428BD642E3F1052A4252EA5ED6FC1F8FA3CC764E31C4F4D18C7B8C6E72A6D8`**. Its result records **five fresh owned phases, 29 steps, eight screenshots, `pageErrors:[]`, `inputsUnchanged:true`, `sourceUnchanged:true`**. Root reports no owned application process remains after cleanup. Each phase uses its own native session and profile; fresh reopen is a separate clean process.

| Phase | Actual observed behavior |
|---|---|
| Editable stereo | Actual UI Open/import/Show waveform produces 8192 native buckets and actual SVG channel segments matching every authored bucket. The real 30-pulse repeated 6/8 grid and intra-bar tempo match the literal source-time oracle at zero and +120 ms offset. Negative offset is checked through the visible handle and 1 ms keyboard edit. Zoom limits, wheel pan, Fit, score click and range show both performed copies while complete project/source/history/live redo and stationary native generation/clock/range/loop remain unchanged. |
| Sync editing within editable stereo | Real repeated-beat selection/Add, pointer drag, 10 ms and 1 ms keyboard commits, crossed-neighbor rejection, Delete and Undo/Redo preserve map/asset/settings and produce exactly one command/revision for each changed action. No-op, Escape and keyboard cancellation preserve the document. Actual UI Save As retains exact backing bytes/source/map. |
| Fresh reopen | Natural close and separate clean launch reopen the saved project with the exact map/backing bytes and the same real rendered peaks. |
| Mono asset | Actual UI displays one lane with the authored mono extrema, matching all buckets. |
| Original embedded | Original embedded audio displays before conversion, read-only, with no staged asset/history or enabled sync editing. |
| Real decoder error | An actually malformed authored container produces a truthful error and absent waveform; actual Retry returns the real error with unchanged project state. |

The supplementary native query follows actual UI readiness; it supplies data comparison and does not replace import, Show waveform, gestures or rendering.

| Artifact | SHA-256 |
|---|---|
| `smoke/backing-waveform-0UxSl3/outputs/run-4qYRll/result.json` | `D23777454F1C4034A83F3BCABB101CDC6C0EEDA4704509EE858B0280DA30A838` |
| `smoke/backing-waveform-GLuXRM/fixture-state.json` | `6F79EF273269D2A3D942F0D40E1C8AF376F4358BD49D187F72AFA23EFE9A6936` |
| `smoke/backing-waveform-GLuXRM/outputs/run-zfpagH/result.json` | `5A063D829F2D9C8E773758D9A8A2F34726D18742C57B796638BA557739E98DFE` |
| `tests/desktop/backing-waveform-fixture.mjs` | `8EAEC2BE5C1FD1927654F7EB46003602F373944457A51D85A1BABA170F652FFD` |
| `tests/desktop/parity-backing-waveform.mjs (capture-only correction; final confirmation below)` | `817FE9FF9D90138D0E379505177A3E47A576586A1194B65704CBBFBD5F113514` |
| `SDD/task-7-driver-review.md (includes startup and capture delta reviews)` | `D4C5B9EE4186E1EB26D53E55EC38249AD3854B49873CA114716D2B9C73F6FFAB` |

`smoke` means `.analysis/desktop-smoke/`. Driver `817FE9FF` is **not** the driver executed by the first successful result. After its independent source review, root prepared a new fixture and ran one bounded confirmation on the unchanged product/executable. That result also passes all five phases, 29 steps and eight captures with no page errors, unchanged inputs/source and no owned application process remaining. No product rebuild or unit-suite rerun was needed for this driver-only change.

| Confirmation artifact | SHA-256 |
|---|---|
| `smoke/backing-waveform-9bjOw8/fixture-state.json` | `D76B4DB1122AADA9875E09D5B47B50BC37B1DA2B1572E71719D0FD17F039CA04` |
| `smoke/backing-waveform-9bjOw8/outputs/run-AqBpw1/result.json` | `916DF9809B94F9E578448E77807131B3E9603EFFD873103AE4C47B0A3C95C192` |

## Actual screenshots and visual review

Root and the fresh visual reviewer inspected the actual GenAI reference and all eight successful-run PNGs in one batch. The independent review **passes the inspected layout and captured states, with no concrete P1/P2 visual defect**. It confirms readable compact controls and repeated-measure labels, sparse truthful impulse traces, contained error/Retry, original embedded read-only cues, preserved score area and dock boundary before Inspector.

At 960×720 the waveform view is 113 px high and ends at x=680 before the responsive right panel; at 1280×900 and 1600×1000 it is 145/161 px high and ends at x=996/1296 before Inspector x=997/1297. No horizontal body overflow was found. Sparse impulses and long silence are factual for this fixture; the concept's dense texture is not waveform evidence.

All eight files below are under `.analysis/desktop-smoke/backing-waveform-GLuXRM/outputs/run-zfpagH/`. Actual file hashes were recomputed and match the immutable result.

| PNG | SHA-256 |
|---|---|
| `editable-stereo-waveform-960.png` | `8DB8216B5937AF9DB9D41A829B0F1BF03B17BCCD3D76B9A885CF18611F2DB6D8` |
| `editable-stereo-waveform-1280.png` | `BF4CA065E49258F337BD10D9D8B864C4193AC119C9E21D19AFD42D4E3E5F95D0` |
| `editable-stereo-waveform-1600.png` | `A29C1ECD45E99122F74A3D1B32828EEF48BE68C97768DACF598A2001A04266F5` |
| `editable-stereo-focused-sync-point-1280.png` | `B32DF75131C2AD3B6675C32F72725FB13265479BD4603185BE65241FF6BDB047` |
| `editable-stereo-actual-neighbor-error-1280.png` | `F0549A58C053BF7B139938AA040CE596680A19F4FA8E3DA2436DFEFC39561D17` |
| `fresh-reopen-reopened-map-1280.png` | `9CC283071D1280ADED4892B17C003F22ABC428F03F56EB2253438B0083111887` |
| `original-embedded-read-only-1280.png` | `D2F2153514973032985F4AA7EFC881911A99811D599386E86B8D0C508CBB9AE4` |
| `real-decoder-error-error-retry-960.png` | `40323B272EEC2729410DA7D5619A00792BF8A646A9463B46026485A0E2C2467D` |

Final visual review `.analysis/parity/backing-waveform-visual-acceptance-review.md` SHA-256: **`515012DC6E4D50017354F5E4C4C091B51D357C8FDB98262D38BBF611BED9714C`**. The initial batch review was `DFB02F0559B9F49CFD66EB8CBF18C0B23D9BDB6C449EB0F49420B28EB20AFB42`; the final report adds the focused confirmation below.

The original file named `focused-sync-point` did **not** prove the selected-point readout or keyboard focus-visible outline. The committed drag changes revision and clears transient marker selection; the old capture only called `focus()`, leaving the default footer instruction. This was a capture gap, not an established product defect. The reviewed driver-only correction uses a real stationary handle click, Tab/Shift+Tab, actual active-element/`:focus-visible` and selected-footer assertions plus exact unchanged document-record verification before capture.

Root and the fresh reviewer inspected only the new confirmation focus PNG and accepted its visible white focus ring and full selected footer: Measure 1, occurrence 2, Position 0.50, Source 8,000 ms. This actual click/keyboard route injects neither CSS nor chosen state. It supplies the replacement focus/readout proof; the other seven accepted layouts retain the initial inspected batch above. The final visual review closes both previously withheld claims and requires no further visual pass.

| Replacement focus capture | SHA-256 |
|---|---|
| `smoke/backing-waveform-9bjOw8/outputs/run-AqBpw1/editable-stereo-focused-sync-point-1280.png` | `5D38F217A5A05F828C072F03617264ED97476D8FD737039B16B7B5FFA1C3A6BF` |

## Remaining acceptance and limits

| Gate | Checkpoint status |
|---|---|
| Tasks 1–6 contracts, reduction, projection, headless query, UI and existing-dock join | Accepted source and joined checks pass |
| First four Task 7 items: reviewed driver/build, functional workflow and visual acceptance | Checked in the plan, supported by the preserved successful Windows results and visual review |
| Actual selected-point readout and keyboard outline pixels | **PASS** — bounded confirmation and root/fresh-reviewer inspection of replacement PNG |
| Final Task 7 overlay adoption, ledger closure, independent joined review and delivery | Tracked separately in the live plan and parity overlay; this evidence file makes no push/remote claim |

Baseline inventory fields are unchanged. P16's existing native clock/tempo-related work remains a separate partial assessment; tempo extraction/generation and entry/exit brackets are not supplied by this slice.

These receipts establish selected Windows diagnostic behavior on the exact executable and authored fixtures. They do not establish actual Guitar Pro 8 runtime equivalence, physical PCM/output fidelity, current macOS/Linux runtime or shipping-package/install/signing acceptance. OS-injected pointercancel/lostcapture, dense real music, 200% scaling, loading/empty/preparing pixels, zoomed/panned screenshots and a running playhead are outside this actual screenshot set; their source/unit coverage or functional assertions do not silently become pixel evidence. Prior accepted audio, Long, Library/recovery and OLE results retain their own scope.

The initial documentation worker used scoped file reads, selected result metadata and SHA-256 checks; it ran no tests, builds, Cargo, application/CDP, Git or network operation. Root subsequently narrowed the offset and overflow claims to the actual driver assertions and moved mutable delivery status to the live plan/overlay. These documentation edits do not alter the runtime receipts.
