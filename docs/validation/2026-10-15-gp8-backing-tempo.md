# P16 backing reference timing validation

2026-10-16 (Europe/Tallinn). **Root accepts the bounded native and Windows diagnostic evidence below. P16 remains partial; documentation adoption and delivery are pending at this checkpoint.**
This joins the accepted source, native PCM/transport, actual Windows, GP publication and bounded visual receipts. It does not close full P16 or the overall GP8 goal.
All paths below are relative to the authoritative checkout. `SDD/` means `.superpowers/sdd/2026-10-15-gp8-backing-tempo/`; `FINAL/` means `.analysis/desktop-smoke/backing-tempo-hg39T7/outputs/run-wyECOa/`.
Root executed the named builds and Windows workflows and accepted the attributed source/test reports. The final document review reads those receipts; it does not rerun their checks.

<!-- backing_tempo_scope_contracts:start -->
## Scope and contracts

The bounded native slice adds Score follows audio, nondestructive physical-source entry/exit brackets, occurrence-aware interior sync points, derived segment tempos and explicit score/sync conversions. Audio follows score remains the legacy omitted/null default.
The effective playback clock is derived separately from authored score tempos. A reference timing edit regenerates the native plan; once preparation has settled, a mix-only edit retains that generation. Notation converts authored milliseconds through musical ticks rather than receiving effective milliseconds directly.
Stored coordinates obey `physical source ms = stored audio ms − offsetMs`. Reference mode admits signed stored pins only when physical bounds are valid. The source asset is retained, with no destructive trim or second player/clock.
Entry is the first performed body/downbeat; exit is the exclusive final occurrence end. Initial grace remains score-only pre-roll. Native source reads obey `[entry,exit)`; active duration is independent of long, muted or omitted backing PCM.
From score Replace/Add uses the captured authored map. Write score tempos is one atomic replacement, rejects incompatible repeated-pass BPM functions, and preserves the reference map. Changed actions are one history step; no-ops preserve redo.
Current-document GP publication uses detached selection/projection plus revision/source-bound current bytes. Unsupported included selections block publication; clearing Include backing audio keeps selected notation export available.

| Contract or accepted source gate | SHA-256 |
| --- | --- |
| `docs/superpowers/specs/2026-10-15-gp8-backing-tempo-design.md` | `E39E511B104C8E4B11BE4192EF29BE0E7AB5F5AE66B8E0729AEA868DDD6945BD` |
| `SDD/task-8-root-acceptance.md` | `CCB482E3E6F47A5FF7CD013EDCADF6DA59B9D7F97B99F7B836168738DA151923` |
| `SDD/task-8-joined-review.md` | `3B9542F502A4004CF96FC386412FD5AE46EE0AF734B197FEB705DAF751B2860C` |

The joined review accepts the source seams for historical replay, captured UI/controller transactions, native source admission, effective/native versus authored notation time, omitted-PCM export, and both GP export entry paths. Producer-internal evidence retains its original bounded scope.
The query-specific encoded-container read ceiling is 512 MiB. It is not a universal import limit, decoded-heap bound, streaming API or general performance guarantee.
Native `.tabplayer` capabilities can be accepted while GP bracket clipping/import/export compatibility remains open. Endpoint sync points do not establish proprietary bracket encoding.
<!-- backing_tempo_scope_contracts:end -->

<!-- backing_tempo_source_verification:start -->
## Source verification and build admission

The coherent whole-suite checkpoint is `dd696ad`, dated before the later visual fixes. Its results must not be described as a whole-suite rerun at final source `447d2a9240dc5727ff0679b5b0f84dd7107db603`.

| Executed coherent check | Recorded outcome | Receipt SHA-256 |
| --- | --- | --- |
| Frontend `npx vitest run --maxWorkers=2 --testTimeout=15000` | 162 files, 2524 passed, one existing skipped | `SDD/join-frontend-full-confirmation.log` — `E017CC160CAB0C22EC8B784D6A2BD2545439888531A4353154130FB6BE34AAE0` |
| Native locked Rust 1.88.0 whole suite | 586 passed, nine existing ignored, 39 successful suite summaries | `SDD/join-native-full.log` — `0A7CECE898D2D9053817212398511B166318DAF56C8EFB750BC73A6E1BCB9793` |
| Typecheck | exit 0 | `SDD/join-typecheck-final.log` — `EC5776F12086906BF4E72E53A33DD3354AAFC4227134457F808D612631FEB1D6` |
| Rust formatting | exit 0, empty output | `SDD/join-fmt.log` — `E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855` |
| Resource tests | 24 passed, two existing Windows link-privilege skips | `SDD/join-resources.log` — `D6CD7641FCA53474F477FFF1C70784D2A97CDD1BB77D2B34B312DD7074B0643E` |

The one visual correction batch changes five paths: App dock allocation and its tests, BackingPanel display formatting and its tests, and the desktop capture driver. Native product/test bytes are unchanged by that batch.
App's focused GREEN has five passes: two new compact-dock cases and three incumbent reveal cases, with 115 filtered tests. Its RED failed the independent 56 px plot budget. Frozen report `SDD/task-9-dock-fix.md` hashes to `5C660B34DD0060E39B2D530CB08E66C3F4A3EF9FCDE0DD80893EB328CE2A1EEB`.
BackingPanel has 23/23 passes, including two new tests. Behavioral RED exposed `7000.000000000001`; GREEN displays `7000`, preserves seven fractional millisecond display digits, unchanged stored values and full custom draft/commit precision. Frozen report `SDD/task-9-number-display-fix.md` hashes to `4699948E66FA272486F4BC22A99A184AF7C8DB6360BA6B2C291471A603F52164`.
The driver passed `node --check` and inert `--help`, plus fresh bounded review. Its final SHA-256 is `5028DAFB10E00E6DFC9B5E081F0FD926FF5FB47CE93C2054261241B949959A5B`; report `SDD/task-9-visual-capture-fix.md` is `614275CF82CFEBF550F881C7105DE70CAC4446FA49592A43698ECF4E29462BE4`.
Those UI/driver deltas did not trigger another whole frontend/native run. Their scoped checks, fresh delta reviews and final actual confirmation are the later evidence.

| Final admission/build binding | Value |
| --- | --- |
| Admission | `.analysis/parity/backing-tempo-build-admission-confirmation-root.json` — `2BDD1E2148A419951C73A8835C0357794E064241DD86F7A32C82BFF57882D2A7` |
| Source commit / manifest | `447d2a9240dc5727ff0679b5b0f84dd7107db603`; 1415 entries; manifest `1F4A13D342253BE3BABCC01FC802BBB483A2DA23F282D603097462BD2148F199` |
| Diagnostic executable | `.analysis/desktop-smoke/tabplayer-p16-447d2a92-confirmation.exe` — `76839ABE817786776F797693D8152CF3E8E30D800871B205F3CB4DC332AB5CAE` |
| Production renderer build | exit 0; `SDD/task-9-production-build-confirmation.log` — `690E76A4C9ACC4A4727BC5389FBFD8E0B4D378AC0CE91CF0463FBEC8A9BFE35D` |
| Diagnostic desktop-test build | exit 0; `SDD/task-9-diagnostic-build-confirmation.log` — `5FDBC6F873801D38C3239C646B625F6525D3498200E26F5820514E28999F2DBE` |

Both final build logs execute `tsc --noEmit && vite build`; this supplies current typecheck success. No separate latest standalone typecheck run is claimed. Vite's recorded large-chunk warning remains a warning.
Admission binds the diagnostic configuration and prepared audio/16 Library files. A `--no-bundle` Windows diagnostic build and prepared worktree resources do not establish installer or extracted shipping-package acceptance.
<!-- backing_tempo_source_verification:end -->

<!-- backing_tempo_native_pcm_transport:start -->
## Native PCM and transport evidence

Canonical receipt join `.analysis/parity/backing-tempo-native-receipt-join.md` hashes to `E908FEC7AA2AFC042DDDDC30244AD480004AEB032D13CD835AF5B5858EB47BBF`. Its requirement map names executed tests and inspected assertions; invocation counts overlap and must not be summed as unique tests.
Direct BackingVoice PCM establishes one source second per wall second at 100% and 0.5 source seconds at 50%, using original stereo impulses across a literal 120→60 BPM interior change at 44.1/48 kHz.
Exact entry/exit frame and fractional interpolation-neighbor tests establish included entry and excluded exit samples. Accepted source review covers the shared grain/correlation/transient gate; this is not separate instrumentation of every internal read.
Direct renderer tests establish exclusive note/MIDI/click ceilings, fractional active end and held-voice suppression across mix/stem paths. Grace tests establish backing silence through the speed-scaled grace pre-roll (62.5 ms at 100%) and retained source pitch at the tested ratios.
Headless transport/offline render tests establish active end despite long/muted/omitted backing. Whole and selected output frame counts retain a 500 ms wall tail; the literal 6 s body at 50% plus tail is 600000 frames at 48 kHz, or 12.5 s.
Runtime seam tests capture and validate the current encoded source before reference PCM omission; missing/corrupt/short source, dishonest effective BPM and missing authority reject. A valid omission retains timing without installing a backing voice. These tests do not publish an actual WAV/stem through the Tauri command.

The initial receipt join explicitly found that old evidence rejected out-of-range reference loops but did not prove a successful reference range/loop source clock. The authorized supplement closes that precise headless PCM gap.
`reference_ranges_and_loops_keep_pcm_source_clock_across_tempo_change` accepts ticks 1920–5760 across the tempo seam, physical source seconds 2–5, at both rates and ratios 1/0.5, rendering irregular 127/511/1024-frame buffers.
Stereo sentinels independently identify three range attacks, exact end/silence, seven attacks through two loop wraps, completed passes and the final tick. The test leaves all eleven earlier helpers/tests byte-identical and changes no native product behavior.

| Supplemental executed check | Outcome / SHA-256 |
| --- | --- |
| Full focused `reference_sync` target | 12 passed: eleven existing plus one new; `.analysis/parity/backing-tempo-task9-native-positive-final.log` — `6CD94E5C1544A4B05A106C8DD3B4A48BD41A0DFCF854F49619350C9711E3E9D0` |
| Test-only wrong-map negative control | compiled, then failed the independent stereo-source assertion; restored afterward; `.analysis/parity/backing-tempo-task9-native-positive-negative-control.log` — `DCBBECE4E0B9C322DBC7B3CFAB2E38029CD938D67C51B1B08507CFBF035BD234` |
| Final integration test source | `src-tauri/tests/reference_sync.rs` — `9F698E81881FE451C8654563A485D14EC782CF4096511CF793DC8A7EF0EF2BDC` |
| Scoped format and fresh test review | exit 0; independent bounded review PASS, no important findings |

This is direct PCM, renderer, headless callback and factored runtime evidence. It is not hardware callback measurement, physical listening, live device recovery or proprietary GP8 audibility. Reference pause/resume and arbitrary loop configurations are outside the supplement's claim.
<!-- backing_tempo_native_pcm_transport:end -->

<!-- backing_tempo_actual_windows_workflow:start -->
## Actual Windows workflow

Final immutable receipt `FINAL/result.json` hashes to `BCAF1CAE5917C49148D3152EC2AD5F8BB36520F393905E8BD2E821605A5130EB`: `status: passed`, 94 asserted steps, nine owned phases, twelve PNGs, `inputsUnchanged: true`, `sourceUnchanged: true`, `pageErrors: []`.
Its deliberate `task9Complete: false` remains immutable. Root external acceptance and versioned evidence/adoption are separate from the driver's functional status.
The fixture-state SHA-256 is `1314A0F6A0BD6328AA5CC73BD750CAEAFA0A2BA79583362A15631F70C4A931CB`; admission and receipt each contain 1415 source-hash entries and the same manifest/executable bindings above.
Only original authored short GP scores and stereo WAV impulses/tone are used. There are no user songs, private banks or recording inputs in this evidence.

| Owned phase | Actual verified behavior |
| --- | --- |
| `reference-edit` | Actual Timing enables reference; numeric Enter and pointer/key-up edits publish once; own-busy draft remains usable; Escape/blur/invalid/EOF cases preserve history and redo; one interior source pin derives 120 then 60 BPM. |
| `reference-edit` timing | Actual measure seek plus public native seek binds native seconds, UI clock, waveform physical source and authored notation cursor. Tick 3840 → 2 s/source 3000 ms; tick 4800 → 3 s/source 4000 ms; active duration 6 s. |
| `reference-edit` conversions | Compatible Write replaces authored tempos; identical Write is a no-op. From score Replace/Add preserves the authored model, merges or removes only intended interiors, and agreeing Add preserves a real live redo candidate. |
| `fresh-reopen` | Actual UI save, clean natural close, unique fresh-profile reopen, persisted map/history/assets. Saved `reference-edit/saved.tabplayer` SHA-256 `BF74949200C8106F7E74D6C91797A05B7AA34B7F4DFBE4C9AD481F5F23B32C13`. |
| `repeat-conflict-gp` | Incompatible repeated-pass Write rejects atomically; actual included GP ambiguity blocks native publication; clearing the checkbox enables the selected notation artifact below. |
| `unique-current-gp` | Supported selected current-audio publication retains its original physical source window and exact active bytes. |
| `compound-6-8` | Literal six-pulse 6/8 source map is accepted. |
| `grace-pre-roll` | Tick 120 → 0.0625 s/source 1000 ms; tick 1080 → 0.5625 s/source 1500 ms; active duration 2.0625 s, with authored notation cursor agreement. |
| `structural-eof` | Extension outside decoded EOF rejects before native history. |
| `original-read-only` | Original embedded source stays read-only and unstaged. |
| `actual-source-error` | Actual decoder error is view-only, with retained document/source/history/assets. |

All nine phases record an exact owned WM_CLOSE request and verified natural exit. The final cleanup boundary records `deletedPaths: []`, retained owned artifacts and `broadProcessKill: false`; each launch binds PID, executable path/start identity, unique profile and CDP listener ancestry.
Capture presentation/focus actions compare the full document record. The four reference viewports and focused-number retain revision 11/project SHA-256 `C4337DB34834530B572713FEFAAD2A42662AF7A17A11C9061A939730B3A76545`; fresh reopen retains revision 0/project `7E5F86F715C27E088C013173A68A6EDFA7B4B3A17ED49E5266721A7174662335`.
No Play/device-selection/physical-capture action occurred. The quiet listening window had ended; successful prepared idle/seek state is not new audible evidence. Pointercancel/lostcapture/windowblur and stale asynchronous settlement remain focused component-test evidence, not actual OS injection.
<!-- backing_tempo_actual_windows_workflow:end -->

<!-- backing_tempo_actual_gp_publication:start -->
## Actual GP publication

Both artifacts below come from `FINAL/`, after the final source-bound actual confirmation. They are not the older third-run exports. File hashes were rechecked; GPIF/music/audio values are the receipt's independent archive/parser oracle.
The real repeated-selection modal associates its actionable ambiguity issue with the checked Include backing audio control, disables Export, remains intentionally workspace-busy, and records no publication. Clearing the checkbox then publishes at the captured native revision.

| Actual artifact | Captured publication and content |
| --- | --- |
| `repeat-conflict-gp/published.gp` | `document-2136-7`, revision 0; original selection `{first:0,last:0}`; backing false; selected frets `[5,6,7,8]`; parsed active backing null, sync empty, no active audio SHA. |
| GP artifact SHA-256 | `C3BD29C7AB038BB6825AC8B863AF9A2F275D396B3421E7E9410111B214E84D89` |
| Generated GPIF SHA-256 | `C1B0B5F17D6049A85CD15B7BA7C6DFFD3FDF2EA6088DD28FF0A4202992D4CFC3` |
| `unique-current-gp/published.gp` | `document-47160-7`, revision 0; original selection `{first:2,last:2}`; backing true; selected frets `[13,14,15,16]`; fresh selected bar/occurrence 0, endpoint ratios 0 and 1. |
| GP artifact SHA-256 | `BA03F15075B1B4553EE95E67C98AB840B012DC3B8C862ABEDD71F72A059A2EFA` |
| Generated GPIF SHA-256 | `B3A4970AE3326D4AE48A3F109A2F356A745635C9DA516EAC86519EBBBB3206F3` |
| Current audio SHA-256 | `B96EE5FC5F2850F5B39ADA070B11B4C266E856CD9DC9C766063B05B5DD5CFAE0` |
| Physical selected source map | selected 0..3840 ticks → original source 3750..5750 ms, preserving the current audio bytes rather than resetting the source window. |

Both exports retain their complete live revision/project/source/history/redo/asset record. Publication is native and revision-bound; the UI preflight is not treated as sole authority.
Omission removes active backing and sync authority. Preserved unreferenced source archive siblings may remain, so the checkbox does not promise removal of every audio byte from a GP ZIP.
These are real publication/GPIF/current-byte checks, with supported public quantization semantics. They do not demonstrate proprietary bracket clipping, GP8 playback, backing mix/pitch/filter interchange or gradual-tempo expansion.
<!-- backing_tempo_actual_gp_publication:end -->

<!-- backing_tempo_visual_reference_confirmation:start -->
## Visual references and single confirmation

Both actual GenAI references and provenance were inspected before their respective UI implementation. Generated geometry, timing values, blended stereo depiction and italic error styling are illustrative; real mono/stereo lanes and existing workstation/dialog identity remain authoritative.

| Pre-code reference/provenance under `docs/design/reference-workstation/` | SHA-256 |
| --- | --- |
| `backing-tempo-concept.png` | `8F3F6B33FA1C6099168DE4D84E428AA0203A49C2B3B00883E0F4084725F25666` |
| `backing-tempo-generated-concept.json` | `DEB694E67ACC5C91527028BDF4C4ED28CBE1F71F0D2F0C87E6EC114298532FF3` |
| `backing-gp-export-concept.png` | `5AB74C5408A5E56E237A3F161791951AE718D91CC969030D2F6211974C218E9D` |
| `backing-gp-export-generated-concept.json` | `B2522CFBA68155BBB12FB1FB627D37E0A4A10D1CB7CCB580687F3D65B2CB2DCA` |

Initial single batch `.analysis/parity/backing-tempo-visual-batch-review.md` (`B3060BBD5845EB1FC6C21E5D5B8D6DBBF98EDB5034E75E7E8107F465BD4D5F5B`) inspected both references and all twelve original third-run actual captures. It withheld acceptance for compact plot clipping, numeric-focus visibility evidence, and overlong persisted Exit text.
One correction batch raised only compact Backing dock allocation, formatted displayed source milliseconds, and made capture state deliberately visible/unobscured. It retained exact model/draft values, real waveform data and full-record invariants.
Exactly one post-fix confirmation followed: `.analysis/parity/backing-tempo-visual-confirmation.md`, SHA-256 `A458AF3F39328E820C4EF5DB4F5F82F82C166B35F56B759D805C6BC926E6CF22`, PASS for the three identified issues, no residual within that scope.
The fresh reviewer inspected the four reference viewports, focused-number and persisted-map original PNGs once; root also inspected those exact six. Both stereo lanes/full marker are visible in compact plots; Entry is fully visibly focused; responsive timing controls are unobscured; reopened Exit reads `7000` fully.
Reference plot viewport/content heights are 77 px at 960×720, 1280×900 and 1280×620, and 93 px at 1600×1000. Wide docks end at x996/x1296 before Inspector x997/x1297; narrow x680 has no Inspector. All twelve final PNG hashes below were rechecked against the immutable receipt.

| Final original PNG under `FINAL/` | Size | SHA-256 |
| --- | --- | --- |
| `reference-edit-legacy-1280x900.png` | 1280×900 | `8D706906495407E1AE9C9B8CCED48914625D8B7C5C4F94C8E9A64DA99CEC8D10` |
| `reference-edit-reference-960x720.png` | 960×720 | `BD8F3899A7F87917A667A70B5F2F8129EA1C04D1B0D1026D4AB35DB51DB39025` |
| `reference-edit-reference-1280x900.png` | 1280×900 | `2B86E2A4C30AFFDD3EF010127684B99A464671A7D9A46CE059B6339020911B1C` |
| `reference-edit-reference-1600x1000.png` | 1600×1000 | `8B1A9828AE4F4CA46616F19E8FAEE95248AA94873F29D77FCC30A40FC317079C` |
| `reference-edit-reference-1280x620.png` | 1280×620 | `FD836EDE1EF0F0D7FF6C21F80E4D1AD21827067F93D2C14D537BBE5A0D06CE79` |
| `reference-edit-focused-number-1280x900.png` | 1280×900 | `CE58D07E63F5B7389358302D8F56D28E3E90DF7196419CDD12EFF9971B5E49D0` |
| `reference-edit-focused-endpoint-1280x900.png` | 1280×900 | `5B8D85BE03B673130569FE72C173CF3ADE876E52C532F581B158A5FA0E531DAE` |
| `reference-edit-outside-error-1280x900.png` | 1280×900 | `A3E8E91B7CC8DD0A36CDEE757EE3ED863E4EFD138D3F089384AB2A40793DB5E9` |
| `fresh-reopen-persisted-map-1280x900.png` | 1280×900 | `FE54B35D1DBAB596BA37A30E23BC3BE7D0C31E855C7A0F4ADF39397DE114E22B` |
| `repeat-conflict-gp-focused-gp-checkbox-error-1280x900.png` | 1280×900 | `425DD5DCFD4E3BDDFE4B1A22AC709225E17F45CF893783EE7F8F429190F573B7` |
| `original-read-only-read-only-1280x900.png` | 1280×900 | `4BDE68131CF92FC03D100660730CF20B2326067AFC6C6453195372EB57F339FF` |
| `actual-source-error-decoder-error-960x720.png` | 960×720 | `101A1CC6DFE23D0ECB48DAB4CCB08B57078DA42260D48B44AFC4B0D739F304C1` |

All visual passes are exhausted: one initial batch, one identified correction set, one confirmation, then stop. The confirmation is not a new broad visual audit. Private capture bytes remain outside versioned documentation/source.
<!-- backing_tempo_visual_reference_confirmation:end -->

<!-- backing_tempo_failures_limits:start -->
## Retained failures and acceptance limits

The first whole frontend receipt `SDD/join-frontend-full.log` (`0F939138DD25C2060B6EA5C6D0E40303401185AEF2A92835ADEB6C5A3D6FF989`) retains one Clipboard preservation failure: expected repetitions 2, observed 1. The exact timing cause is unproven. The test-only correction awaited observable initial destination mapping 0 and enabled Paste repetitions before drafting; preservation/history/New/paste/Undo assertions and timeouts remained. The complete frontend subsequently passed alone.
First actual `run-isrO0q` in `.analysis/desktop-smoke/backing-tempo-lj6OUI/outputs/` remains failed, SHA-256 `8EA3639F67421B34665BD6F4FB737503D5E7AD37B5E99594F7A9B8C005228C3E`: exact Timing-label locator matched zero controls because nested select options enter Playwright's label text. Three driver-only locators were corrected; no product disclosure/readiness fix is inferred.
Second actual `run-KWcYYR` in `.analysis/desktop-smoke/backing-tempo-pWqYz7/outputs/` remains failed, SHA-256 `475702AA5EA7D6186EFFB7094ADA77A2D5B404FCF8EFF84A3F4B4D76572DCA4A`: the driver awaited default workspace idle while the actual Export modal intentionally held its operation lease. Two modal-related driver calls were corrected without increasing timeouts or weakening full-record/publication assertions.
Third actual `run-J9qHqD` in `.analysis/desktop-smoke/backing-tempo-sOsGSh/outputs/` remains passed for 81 steps/nine phases/twelve PNGs, SHA-256 `0F7975399195F9DFA0223A1CEF2779AB9DDCB03C6C9DF82D00C084FD8FDE1E5A`. That functional pass exposed the three visual defects in the one review batch; it was not silently upgraded to visual acceptance.
Old failed/passed receipts, binaries and captures remain immutable. The final 94-step confirmation has its own admitted source/executable/fixtures and does not overwrite them.

Accepted evidence supports the bounded source/native PCM/headless transport/current Windows workflow and actual GP publication, plus the three-issue visual confirmation. Overall P16 remains partial because native GP bracket clip encoding/import/export compatibility is open; no invented private XML fills it.
Original GP8 runtime equivalence, mixed backing/pitch/filter interchange, native gradual-tempo expansion, physical device playback/listening, macOS/Linux runtime, shipping/installer acceptance, CI and the full 258-item goal are not accepted by these receipts.
Earlier P15/audio/Long/Library/OLE evidence and historical baseline/other ledger rows remain dated and unchanged. There is no main promotion or overall goal-complete claim.
The source checkpoint is local and unpushed at this dated acceptance checkpoint. A later root delivery receipt must separately establish scoped adoption/commit/push, remote state and the actual current CI snapshot; no future delivery or fake CI result is asserted here.

**Root acceptance: the documented source/native/Windows/GP-publication and bounded visual scope is accepted.** P16 remains partial. One-row documentation adoption, independent final review and Git delivery remain pending at this checkpoint; the immutable driver field remains `task9Complete: false` as root external acceptance is recorded here.
<!-- backing_tempo_failures_limits:end -->
