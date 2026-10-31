# P17/P18 backing pitch and frequency-filter validation

2026-10-16 (Europe/Tallinn). **Root accepts the bounded functional evidence and sole targeted visual confirmation below. Final document/adoption review and delivery remain pending at this checkpoint.** This is a bounded P17/P18 checkpoint; the overall GP8 parity goal remains open.

All paths below are relative to the authoritative checkout. `SDD/` means `.superpowers/sdd/2026-10-16-gp8-backing-processing/`; `ACTUAL/` means `.analysis/desktop-smoke/backing-processing-0dVltF/outputs/run-ehJgi3/`. Root executed the builds, checks and Windows workflow. Independent reviewers assessed the named frozen source/evidence packages; this document does not represent another execution of their checks.

<!-- backing_processing_contracts:start -->
## Accepted scope and contracts

The [design](../superpowers/specs/2026-10-16-gp8-backing-processing-design.md), SHA-256 `F0A4143960845654209DBE2490BA7A799AAF1571A68714931C58CF2F86260C01`, defines TabPlayer's local policy. The [implementation plan](../superpowers/plans/2026-10-16-gp8-backing-processing.md) records the bounded execution and explicit native-observer continuation amendment. The official backing manual supplied feature names; original GP8 bounds, curves and processing metadata were not measured.

- `BackingSettings.processing` is optional and nullable. Missing/null defaults to `0/0/none`; legacy documents need no migration. A present processing value must be a map containing exactly `semitones`, `cents` and `filter`. Positional arrays, tagged-enum objects, unknown/missing fields, coercions and invalid values reject. TypeScript also rejects a present `undefined` value.
- Semitones are finite integers in `[-12,12]`; cents are finite integers in `[-100,100]`. Values remain separate, without carry or normalization. Audible pitch uses their additive total, permitting combined endpoints of ±13 semitones. Cancellation such as `-1/+100` uses the exact neutral PCM path, while changing the raw pair remains an intentional history edit.
- The six modes are Bass Enhance/Attenuation, Medium Enhance/Attenuation and Hi Freq Enhance/Attenuation, plus No Filter. Local DSP uses the existing 180 Hz low shelf, 1000 Hz peak (Q 0.7) and 4000 Hz high shelf at ±6 dB, with the existing `0.45 × rate` frequency clamp and supported 8–192 kHz output rates. These are TabPlayer curves, with independent channel state; no separation, channel matrix, normalization or added limiter is claimed.
- Pitch changes the within-grain read stride. Score ticks, mapped source origin, hop cadence, source-frame gates, BPM and duration retain their existing clocks. The filter follows transient assembly and precedes backing gain/pan. Seek/exclusion/nonfinite/EOF/tail handling resets or suppresses processed backing as specified.
- Processing-only native settings updates reuse decoded audio/resources/plan through the existing prepared preserved-install path. Gain-only updates retain the inexpensive mix path. Score events and score stems remain unchanged; frozen mix/backing exports use the same processing.
- The compact Pitch & filter disclosure follows the generated concept in the existing left Backing sidebar, below mix and above Sync timing. Enter commits once; invalid Enter cannot commit a previous valid value. Escape/blur and existing session cancellation remain local. Pending edits retain their lease; competing controls disable. Original embedded audio has no committed processing controls until the existing Edit path is used.
- Included GP export rejects an audible nonneutral transform at both preflight and direct projection: `Backing pitch and filters cannot be stored in this Guitar Pro export. Clear Include backing audio to export notation.` Explicit omit publishes notation without active backing/sync. Neutral cancellation can include unchanged source audio. No re-encoding or invented GP processing metadata is introduced.

The shared literal protocol fixture `tests/backing-processing-protocol.json` has 16 valid and 31 invalid cases, SHA-256 `302C17669EEED48CD20C8915BFBD505BAEADB333AA4E7343B93FFC201DA3F374`. Integer decimal spellings are admitted consistently; each language adds direct nonfinite checks.
<!-- backing_processing_contracts:end -->

<!-- backing_processing_source_checks:start -->
## Source lineage and retained checks

The inherited P16 product checkpoint is `447d2a9240dc5727ff0679b5b0f84dd7107db603`, delivered through `ae6fcb8f2023fd685444ffc0fccd7c5dbd678a5e`. Its accepted evidence and remaining gaps are unchanged.

| Processing checkpoint | Identity |
| --- | --- |
| Final strict shared contracts, including map-only native admission | `986875b70fa15b7ae2797f021b572613be615d87` |
| Six-mode DSP | `fc3b8e64db2c73ed44f5a61607658622d586bcf4` |
| GP include guard | `2f941965a87f3336e7a79272f69b1353e64c6cd8` |
| Initial controls/history integration | `2ad44df61dfb632e64fceaff7599215ac54a4b78`; subsequent scoped white-focus fix `bfa2809` |
| Accepted native integration and coherent product source | `4a01c341eca58cb25f52c89175ba1fb8c14ee803` |
| Successful full authored Windows workflow source | `be9e61aa2383974821e7ecf70899e7f755f74f53` |
| Accepted invalid-guidance correction and sole targeted confirmation source | `a87bae29deb08e31a8974d6d2ed390e7b5adca0b` |

The final correction source differs from the successful full-workflow source only in `BackingProcessingControls.tsx`, its existing test, `backing-processing.css` and the targeted desktop driver mode. Comparison of their frozen 1,428-entry manifest maps confirms those four paths; native processing and the observer check are unchanged. The final manifest is `57FFBEF2D7A8D6846ACFBEF84B46B9CAE6EEBB5E81DAB270F03C3BE5C07711D9`. Final build and targeted actual identities appear in the visual confirmation section; the full functional run retains its earlier identities.

Independent Task 1–5 reviews accepted their bounded scopes. Final review bindings are `SDD/task-1-fix-1-review.md` (`EC359FEC376A6FD6B15D23551C42226D8FDBB5B9B4DF3604F33CE2D5FF8F4DF7`), `task-2-review.md` (`77F552FB36ADD85ED3AF2324FC9837D62F44369F05C5BB717E3151F886458A19`), `task-3-review.md` (`7F46141894DC5F0661E1367D4E4F47BF15EAFD349B52E6F8F00871F0720D1217`), `task-4-fix-1-review.md` (`97113B7DDD27B7363B7F9CEFEDFBC06590C3CDC01CCC479E7CE26B3CFA611BCE`) and `task-5-review.md` (`CA04187C454F36C509A4AEEBAF2A9EF6035A96FABD680CBEF496D27B13C39D70`). The original reviews and failed checks remain preserved.

The whole checks ran at native/product source `4a01c341eca58cb25f52c89175ba1fb8c14ee803`, with 1,427 manifest entries and manifest SHA-256 `E0CED136DC145B6CC0BBF91C61B88F85598D7D456B0CA9370BD56D68C290CF99`. Receipt `SDD/task-6-coherent-checks-root.json` hashes to `B748BC445FE380E36DEFB79D3982472F18A2C6E403CDD444316C3B5ECA1918AC`.

| Executed coherent check | Outcome | Log SHA-256 |
| --- | --- | --- |
| Whole frontend | 2,647 passed, one skipped; 166 files; exit 0 | `SDD/task-6-whole-frontend.log` — `E71FD3F5C90BD827D305AF96F6A5A65CC1376674EDDFCF19CE22558152C43066` |
| Node resource tests | 24 passed, two existing skips | Recorded in the same frontend log |
| Locked Rust 1.88.0 whole native suite | 617 passed, nine ignored; 41 successful result groups; exit 0 | `SDD/task-6-whole-native.log` — `E93899284D02603D0CD25E0524D5601F88B61092B6A1DFB558B459F90316B820` |
| Typecheck | exit 0 | `SDD/task-6-typecheck.log` — `EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6` |
| Rust formatting | exit 0, empty output | `SDD/task-6-format.log` — `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |

Between that coherent snapshot and the successful full actual build, the frozen manifest comparison changes only the desktop driver and adds its observer check; product bytes are unchanged. The later invalid-guidance correction changes UI presentation/tests and has separate focused evidence below. These retained whole checks must not be described as a whole-suite rerun at the later visual source or as current-head CI certification. Focused invocation counts overlap and are not additional unique whole-suite totals.
<!-- backing_processing_source_checks:end -->

<!-- backing_processing_native:start -->
## Native PCM, clocks and export evidence

`SDD/task-3-report.md` (`B4C323B20B38CB6FB26995068C56B114DB5AA3A38208F12949CEABEE97A4B142`) fixes the native source and retained command/log manifest. Its independent review checked all 30 source/evidence hashes and the decisive logs. The Task 2 filter review separately accepts the response wrapper and its independent PCM tests.

- Literal 440 Hz pitch targets cover +12 → 880, −12 → 220, +1 → 466.1637615, +50 cents → 452.8929841, −50 cents → 427.4740541 and combined ±13 → 932.327523/207.6523488 Hz. Both 44.1/48 kHz source and output rates and relative speeds 0.1/1.23/3 produce 84 cases. Settled PCM frequency tolerance is `max(1 Hz, 0.3% × target)`, without inspecting the implementation ratio. Equal-total pairs produce equal PCM; cancelling and legacy-neutral input retain exact neutral output.
- The six filter tests measure settled PCM response at literal 80/1000/10000 Hz at both rates and four stereo patterns `[s,s]`, `[s,-s]`, `[s,0]`, `[0,s]`: 144 mode/rate/pattern/band combinations. Target gain has the correct sign and 4–7 dB magnitude; other listed bands stay below 1 dB absolute response. No Filter preserves bits, including signed zero. Reset and supported/invalid boundary rates have separate checks.
- Fractional bracket source pairs differ radically only outside the allowed source interval. Exact output equality covers interpolation, correlation and transient neighborhoods, seek near both boundaries, two pitch choices and three speeds. Exact entry/exit impulses and positive reference range/loop cases cover included entry, excluded exit and post-range silence. Deliberately removing the source gate fails the independent sentinel oracle; the original source was restored.
- The retained 48 kHz diagnostic distinguishes nominal time 1.0 from the stored fractional exit by one ULP. Silence uses the exact mapped source interval; gate arithmetic and equality tolerance were not relaxed. Neutral compatibility deliberately retains the incumbent direct-jump-past-legacy-EOF missed transient and per-channel nonfinite sanitization. New processed output suppresses those frames. Ordinary renderer backing tails are suppressed in both paths.
- A native control-only service queues the actual preserved Install, reuses decoded/resources/plan `Arc` identities, then feeds that Install into the headless callback transport. Installed PCM measures the expected 880 Hz while tick/generation/practice/range/loop remain equal. A following gain-only update remains Mix. Frozen processing survives a rate rebuild. This is headless callback evidence, with no physical device execution.
- Shared renderer checks compare mix/stem PCM, nonzero score-only versus score stems, frame/tick duration and backing-tail silence. Runtime preparation checks decode real WAV source and retain included/omitted source/timing admission, invalid-processing rejection and immutable frozen settings. Existing stale reference-timing rejection remains before publication.

The 84-case matrix passed twice before the final narrow EOF/nonfinite/tail guards; final targeted guard, positive range/loop, native control and runtime checks passed afterward. The later coherent whole native suite passed on the integrated source. The earlier invalid fixture and LNK1104 overlap are retained setup/scheduling failures, not behavioral RED. No original failure or negative-control record was deleted or relabeled.
<!-- backing_processing_native:end -->

<!-- backing_processing_actual:start -->
## Frozen Windows workflow and build admission

`ACTUAL/result.json`, SHA-256 `AC96B9355C8BA97F0C7ECCEA14BD21642459AB58A040FD5AB51A6D3B6EA3AE22`, reports **passed**, 57 asserted steps, five owned phases and nine PNG entries. Its immutable `task6Complete:false` intentionally leaves external visual/document/adoption/delivery gates separate. `inputsUnchanged:true`, `sourceUnchanged:true`, `pageErrors:[]` and `transportFallbacks:[]` are recorded.

| Frozen build binding | Value |
| --- | --- |
| Actual source / manifest | `be9e61aa2383974821e7ecf70899e7f755f74f53`; 1,428 entries; `887C12A98B82CD2E95A7F44E3E696263F9260315BA6B36C5F25AA4AE5C21A072` |
| Fixture-state | `.analysis/desktop-smoke/backing-processing-0dVltF/fixture-state.json` — `0E71077842A18865B21138D8B9F4D73BC1153AECF2A078A0221DAE54A5B92476` |
| Admission | `SDD/task-6-build-admission-bac1f18a-6aa5-4213-92be-803ad2d07328.json` — `516DD622118407790AAACFD7D9B7FF76E884037F12ABE5679AFC39994609D1B5` |
| Unique diagnostic executable | `.analysis/desktop-smoke/tabplayer-p17-observer-bac1f18a-6aa5-4213-92be-803ad2d07328.exe` — `E0C16C6BCE144CC5190367ED913599DE6090903C73D979BFC48DCEF5F75D275E` |
| Build receipt | `SDD/task-6-observer-build-receipt-root.json` — `D943DC32906C291D758225FEF4BDBB6E2505E05C4996C4F3C7EDA4107C8D7BAD` |
| Built resources | `SDD/task-6-built-resources-bac1f18a-6aa5-4213-92be-803ad2d07328.json` — `AA8091DEE077D91324E7B44855D8B02D3972B854BEB111AAAFF5C2AC9ECB88AC` |
| Production renderer build | exit 0; `SDD/task-6-production-build.log` — `2812DD4E998722DFECC9903717B3671E599069302B762E86C42D0618E2D4F5B3` |
| Observer diagnostic build | exit 0; `SDD/task-6-diagnostic-build-observer.log` — `E45643851DE7BFCDF6D605D94D77F02125FF810AFBCE5927E2822A4C1993478A` |

Admission binds source, unique executable, diagnostic configuration and 4,797 regular frontend/resource files; resource and adjacent Library verification exited zero. A Windows `--no-bundle --features desktop-test` build supplies diagnostic evidence, not shipping-package acceptance. The later visual UI correction requires its own new admission; the table above remains the earlier full functional run's immutable identity.

| Owned phase | Accepted bounded behavior |
| --- | --- |
| `processing-controls` | Separate raw pair edits; invalid/incomplete/fraction/out-of-range Enter refuses; Escape/blur/unchanged Enter preserve project/history/live redo; Arrow/Shift previews stay local until Enter; Reset and pending own-lease behavior; all seven ordered filter states; exact processing revisions. |
| `processing-controls` native timing | Tick 3840 → 2 seconds, duration/backing duration 8 seconds, speed 1, source position 2000 ms and displayed `0:02 / 0:08 · M2`; generation/desired/mix generation remain 6 through processing updates. |
| `processing-controls` publication | Real frozen native +12 stems, exact GP include rejection followed by explicit omit publication, UI save and retained original source/backing bytes. |
| `fresh-reopen` | Clean natural exit, a unique fresh profile, exact persisted raw pair/project/assets. |
| `neutral-bands` / `filtered-bands` | Real frozen native neutral/Bass Enhance stems and independent response comparison; unchanged score stems; saved separate filter history. |
| `embedded-original` | Original embedded backing exposes no committed processing controls. |

Each phase requires a read-only normal-invoke `audio_status` capability probe before UI Open. The observer leaves Tauri's immutable invoke untouched and observes the writable fetch transport. Native success requires the actual response header plus parsed result, rather than a null result alone. All 12 processing commits record acknowledged JSON-POST `audio_set_mix`, native `ok` and parsed null. The pending case explicitly holds a real setBacking request, forwards the unchanged original exactly once and releases it in finally; it does not establish natural OS scheduling behavior or fabricate a response.

Five unique profiles/PIDs are joined to the admitted executable, listener ancestry and launch identity. Each exact owned WM_CLOSE is followed by natural-exit verification against executable/PID/start time. Cleanup records no broad kill or deleted paths; six original inputs match their recorded hashes. Only authored short scores and tone/multitone WAVs are used, with no user-song or recording acceptance claim.
<!-- backing_processing_actual:end -->

<!-- backing_processing_artifacts:start -->
## Independently inspected native publications

Frozen functional review `.analysis/parity/backing-processing-functional-acceptance-review.md`, SHA-256 `8A31019F41164F4A58D8FBD454092B24CB57F9E2CE7540448AA34408D5310615`, gives **scoped functional PASS**. The reviewer independently hashed/decoded the saved projects, GP ZIP/XML and all nine published WAVs using standard-library tools without product code, live driver, app execution or image inspection.

All published WAVs are stereo PCM24, 48 kHz, 384,000 frames: exactly 8 seconds. Three publication manifests are equal, with start/end ticks 0/15360, speed 1 and no tail; manifest SHA-256 is `43AEA118D449505CE0C9F4A1CA07FF4740BFC9955DBD90F13D4C1612296D90FC`.

| Independent observation | Result |
| --- | --- |
| +12 backing SHA-256 | `C7FAC15BE9DDFFED289F3367AB78032E8016F211A8420D63C86CEFC2B989902E` |
| Settled +12 upward-crossing frequency, 1–7 seconds | 879.9041911462917 Hz; target 880 Hz, tolerance 2.64 Hz |
| Separate settled 2–6 second estimate | 879.9033255455118 Hz |
| Neutral bands backing SHA-256 | `4CC1E98E77A327167FDAABA4C81F8ED7B43EB87D4A105434B9FF15133EA7E1DA` |
| Bass Enhance backing SHA-256 | `5A6CE196E71FFC75722E2CED7C49AE260D87B5D3E32A19FC0FF79A23B12F02F7` |
| Bass Enhance DFT gain at 80 / 1000 / 10000 Hz | +5.75855162758 / +0.00676501198 / approximately +0.000000342 dB |
| Opposite-stereo maximum channel sum in each backing | 0.0000002384185791015625, at PCM quantization scale |
| Nonempty score stem `base/0`, equal in all three exports | SHA-256 `5603A016B8085A62BBC80916028956E0FC540C217DA2DAEE4DD91979508B4EEB`; decoded peak 0.14160239696502686 |
| GP omit artifact | `ACTUAL/processing-controls/published.gp` — `72A91262E0EC1D90133B1B53FAC91926319E717C77F2B8B65489CF77ADA972BA` |
| Saved main / bands projects | `E054E7AD82E3C8AB97403D513A8CBDE57894C4E2A77ECF2684698E79AC3CD276` / `A86A41D6523C7563020823609605CFDB6AE22D827792855923F3BD9139CDFFC5` |

The GP artifact independently contains one notation track, no audio entries, an empty AudioTracks node, MIDI AudioEngineState and no active backing/sync. This corroborates omission publication, without claiming original-GP8 interoperability. Both saved JSON projects decode to the exact original authored GP/WAV bytes and byte-derived asset identities. Native export and GP publication preserve revision 13 and its project hash; the actual UI save records revision 14, and fresh reopen starts at revision 0 with the same project content hash. Main history ends at `12/0/none`; bands history ends at `0/0/bassEnhance`.

Actual published frequency/response coverage is +12 and Bass Enhance on authored tones. The 84 pitch cases and all six filter responses come from separate native tests. The exploratory EOF-inclusive 6–8 second crossing estimate was 889.8545439113915 Hz; it is outside the settled acceptance window and does not prove general end/transient quality. No arbitrary-music or subjective-quality conclusion follows.
<!-- backing_processing_artifacts:end -->

<!-- backing_processing_observer_failures:start -->
## Retained failed attempts and observer correction

Both earlier actual attempts remain failed and all their artifacts remain retained:

| Failed receipt | Failure boundary |
| --- | --- |
| `.analysis/desktop-smoke/backing-processing-ljBw6h/outputs/run-yQbe7q/result.json` — `20642659516C97B51320297A95C5A4C5C9E554AA305CA07B78BADAF9E78F4E49` | Native Filter wrapping-label query included option text. The driver moved to the exact combobox role/name; no product accessibility workaround. |
| `.analysis/desktop-smoke/backing-processing-70a4jh/outputs/run-vXL70l/result.json` — `A126E51A55531FC14863F93C02A715DBF542CCF00790909477A3393791166614` | An observer attempted to replace Tauri 2.11.6's immutable invoke, leaving mix/preparation observations empty. This did not establish a product audio failure. |

The earlier wrapping-summary source join was also corrected in the driver before those runs. Root explicitly amended the functional-run cap once for a capability-gated bounded continuation after diagnosis and review. The visual batch/correction/confirmation ceiling and exhausted P16 ceiling did not change. The successful AC96 workflow is that amended continuation, with no retroactive pass for either earlier receipt.

The observer now forwards original fetch arguments exactly once and returns the original Response, reading a clone only. Clone/diagnostic errors cannot induce an observer resend. A persistent sanitized warning listener rejects Tauri's later postMessage fallback through final cleanup; a fresh capability probe covers each phase. No invoke key, request headers or function source is retained.

`tests/desktop/backing-processing-observer-check.mjs`, SHA-256 `3AF83407417EDFA7052DDE396356BA0F3939F7283041E2B5C7BEBF872640C667`, has eight passing fake-transport tests, including immutable invoke, normal probe, native success/error distinctions, request/Response identity, exactly-once hold/release, clone error, and late fallback after the last mix. Its deliberate late-fallback RED failed with a missing expected exception before the guard; final GREEN log is `SDD/task-6-observer-followup-green-transport.log`, SHA-256 `972A3178C5FA943CE8697FAC4212F8946CB4C550A5A641027EAB519409B70C6B`. These are fake-only checks, distinct from actual native evidence. Scoped fallback re-review `SDD/task-6-observer-fallback-fix-review.md` passes, SHA-256 `C2DA266B16DDE3F58AB17454679566804CAC348BF91C00AEE44C7313BCA48C20`.
<!-- backing_processing_observer_failures:end -->

<!-- backing_processing_visual:start -->
## Generated design and bounded visual correction

The actual generated reference `docs/design/reference-workstation/backing-pitch-filter-concept.png` hashes to `6B683115A53B4185CC11528D60712E73754A10B7A0F3FAB6BA81740345CB67C4`; provenance JSON `backing-pitch-filter-generated-concept.json` hashes to `108589E1D25B77399B5D722F2F6720B520D652972459B3F0F1CCD19965DEB4E3`. Root inspected the generated concept before implementation, including its corrected left-sidebar placement. Incidental example values and generated blue focus did not override real defaults or the required white keyboard focus.

Root's first and only visual batch inspected all nine AC96 screenshot entries together at 960/1280/1600 widths, short height, numeric/select focus, invalid/pending and original-embedded states. `.analysis/parity/backing-processing-visual-review-root.md` hashes to `0044EEF13BBA4259012C93336C5D277E893BA490ED3AB88F479620F06387B3CF`; its image-hash/geometry manifest hashes to `85AACE39C4610462D61085C416E684F85230EB0A7F8AD0FA202DBC452C4D0472`.

The complete identified set contains one P2: an invalid numeric draft lacked visible whole-number/range guidance. The correction adds an associated paragraph outside both wrapping labels, keeping exact accessible names, and an invalid border while preserving white focus. The message derives bounds from the existing limits and clears on correction/cancellation. Source review found a correction-local muted-text cascade conflict, resolved by a selector scoped to `.app-shell .backing-processing .processing-invalid`. This is the same correction set, without a new visual direction or behavior change.

| Frozen UI correction | SHA-256 |
| --- | --- |
| `src/audio/BackingProcessingControls.tsx` | `3BDF21245FDD64F9AC1A49F266BC49776289531FDA42302D2EE5E35D8CE6B5B1` |
| `src/audio/backing-processing.css`, after cascade correction | `B296F0D912CF4FB2DAC298E34F7FE099C1FF3D64077F9B01B1E420AE7B6BDA05` |
| `src/audio/BackingProcessingControls.test.tsx` | `E94FE393A104B2B267A1F20E740813E19CFC13102F346985CEDDA21553759367` |

Focused controls/panel RED reports two failures/49 passes; GREEN reports 51 passes across two files and typecheck exits zero. The tests exercise seven invalid values for each field, visible associated wording, exact labels, invalid Enter refusal, valid correction and blur clearing. Logs `SDD/task-4-visual-fix-red.log` / `task-4-visual-fix-green.log` hash to `04EE7833382141CA5D162D2EBD49BA265ADCE37E8CDDB86184DEEFB47B33F1CE` / `6DFFC438035A369655F2E0500C18DEF632C363DF254D4C7700EFB733229991CD`. The final cascade source rereview passes (`SDD/task-4-visual-fix-cascade-review.md`, `1B6872274E706ED86457AB2631187DE42EE39043923F56E74BB73A325B27A40D`); it is not rendered confirmation.

The initial short-height image leaves the processing group below the existing sidebar fold and does not establish that group's short-height appearance. The sole targeted confirmation below scrolls it into view and establishes the new feedback/focus. Earlier failed-run captures remain unreviewed and are not accepted visual evidence. No P16 image was reopened.

### Sole targeted confirmation — accepted

Root inspected all four admitted screenshots together and accepted the sole invalid-guidance P2 as resolved. Root report `.analysis/parity/backing-processing-visual-confirmation-root.md` hashes to `F93CA0AD9275D8454357E76A1DD97D5145A4DF5B16748EA9F6ADD8E7FE5BDBD3`; its screenshot-hash/geometry JSON hashes to `F2C99B7271991F264F0CFD276E654B7E0DFB80DF3E03D3DDE1171F1524815A27`. This document checked those evidence identities and read the report without reopening images.

| Targeted confirmation binding | Value |
| --- | --- |
| Accepted source / manifest | `a87bae29deb08e31a8974d6d2ed390e7b5adca0b`; 1,428 entries; `57FFBEF2D7A8D6846ACFBEF84B46B9CAE6EEBB5E81DAB270F03C3BE5C07711D9` |
| Fresh production renderer build | exit 0; `SDD/task-6-visual-production-build.log` — `A4CD31BEFDF6387B300B1CABDD0D4F37573DF6BB5AC06C7DCC54871F68DDF61C` |
| Fresh native diagnostic build | exit 0, 44.65 seconds; `SDD/task-6-visual-diagnostic-build.log` — `5401ECFED5F28797A57A6F340F974B87AA3B0CBB4204CAF42D0502B5A0403215` |
| Root build receipt | `SDD/task-6-visual-build-receipt-root.json` — `00B53B37317824D6815CCE56F74181615426231384963D7B7B4CC3E99CC08D72` |
| Admission | `SDD/task-6-build-admission-bea5d0b5-d9db-46ca-b2f4-5d321ac624a0.json` — `3ADE37459753AB56B661A5666BBB99A05F053952B03E737F6238DDA9A39E7E9D` |
| Unique diagnostic executable | `.analysis/desktop-smoke/tabplayer-p17-visual-bea5d0b5-d9db-46ca-b2f4-5d321ac624a0.exe` — `09A4A99EECBC2B58CCCAFD6F3194935E835ADEDDC9DA367561EE70FDDD0106B5` |
| Built resources | `SDD/task-6-built-resources-bea5d0b5-d9db-46ca-b2f4-5d321ac624a0.json` — `9F190AE143CD5F0774379DFB36257FFE02207B3702E1CFB04ABD8FE087D1102B`; 4,797 regular files |
| Fixture-state | `.analysis/desktop-smoke/backing-processing-1wXckP/fixture-state.json` — `15A55372135C2EB13AC4A9EFBC323D1BD934BE01D8B8EC8AD7530B974C2E076F` |
| Targeted actual result | `.analysis/desktop-smoke/backing-processing-1wXckP/outputs/run-OUQPJK/result.json` — `75E79CE03EF8C8D84CFC58A4D75B37B84C41D21E54BD6812E4E082E2757C43D7` |

The immutable visual build receipt retains inherited observer-build metadata: its top-level `id`, `coherentSourceCapturedAtUtc`, nested `coherentProductChecks` unchanged-product/driver-only claim and `rebuildTrigger` timestamp/reason describe the earlier observer build, rather than this UI correction. Additive corrigendum `SDD/task-6-visual-build-provenance-corrigendum-root.json` (SHA-256 `51610E3CDFBD1A71BD3D5C162EFB94EEEF758414600E699E83A4C90182F8A4F2`) identifies these historical-only fields and independently records the four changed UI/test/driver paths from the full functional source, with no native-source change. Current visual build identity comes from its exact source map/digest, new admission/executable/resource paths and byte hashes, reviewed correction and fresh frontend/native logs above. No new build.rs mtime touch or whole-suite run at this visual source is claimed.

The frontend build runs separately; the diagnostic configuration has an empty `beforeBuildCommand`, so no duplicate frontend hook is claimed. Prepared source audio and adjacent audio/Library bytes remain unchanged. The build is still a Windows diagnostic without a bundle; Vite's large-chunk warning remains a warning. The new admission does not replace or retroactively change the earlier full functional run.

The targeted result passes 17 asserted steps in one owned `visual-confirmation` phase, with exactly four frames, `inputsUnchanged:true`, `sourceUnchanged:true`, `pageErrors:[]` and `transportFallbacks:[]`. Its immutable `task6Complete:false` leaves final document/adoption/delivery acceptance external. The scoped mode's prior source review passes (`SDD/task-6-visual-confirmation-driver-review.md`, `B2F50CEC0C245C2808106C739A3DAF95177D6E362B48A2F902FDAA30C18FD776`).

Semitones `13` shows the full whole-number/−12 to 12 guidance at 1280×900 and, after scrolling, at 1280×620 with the paired fields, feedback and Filter in view. Cents `101` shows the separate −100 to 100 guidance. Invalid states keep a visible white keyboard outline and distinct pale error border/text; the native select also keeps white keyboard focus. Text remains outside labels and competing controls visibly disable. Root found no further material issue within this correction scope.

Invalid Enter dispatches no edit/mix. A local valid Cents `50` draft clears the feedback; Escape restores the clean project/history/redo/assets and native generation/tick/seconds/practice/range/loop. Exact owned WM_CLOSE and natural exit pass. No processing commit, export, Play or full-workflow replay occurred. These targeted checks supplement the unchanged functional logic; they do not repeat the 57-step workflow.

The initial nine-image batch, one complete correction set including its source cascade repair, and this one targeted confirmation **exhaust the visual ceiling**. Visual work stops: no further screenshots, cosmetic micro-edits or freshness rebuilds. P16 remains closed. This acceptance covers the identified new-group guidance and short-height/focus framing only.
<!-- backing_processing_visual:end -->

<!-- backing_processing_assessment:start -->
## Supported assessment and remaining limits

The accepted bounded functional and visual evidence supports **P17 implemented within the declared local numeric scope**: independent semitone/cents settings, preserved score/duration, history/persistence and shared native processing/publication have specific oracles. That classification does not certify proprietary GP bounds, processing-metadata interchange or perceptual quality. **P18 remains partial**: six local frequency-emphasis/attenuation filters are demonstrated, while its historical requirement also names vocal/instrument/center/channel filtering. This slice provides no source separation, center cancellation, channel extraction or AI stems. Historical row wording/status must be preserved; current behavior must state the narrower proven capability.

This document does not mutate the progress overlay or certify its current totals. Final adoption must preserve baseline/history/other rows/prior evidence and frozen CI snapshots, then receive independent review. A documentation audit can cite root's actual evidence while retaining its own `runtime_rechecked_by_this_audit:false`. No delivery commit, remote push or current-head CI outcome has been filled speculatively.

Physical Play/device output, listening/capture, subjective or arbitrary-music quality, general transient/end quality, original GP8 runtime comparison, macOS/Linux and installer/extracted shipping acceptance remain unverified by this slice. Headless native callback and offline exported PCM do not close those gates. The prior P16 bracket/interchange and platform/shipping gaps remain open. Full 258-item GP8 parity remains open.
<!-- backing_processing_assessment:end -->
