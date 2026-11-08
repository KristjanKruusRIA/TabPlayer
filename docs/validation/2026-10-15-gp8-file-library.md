# File Library integration and desktop evidence

2026-10-15. The Library adds recents, personal/factory templates, original offline examples, local folder metadata indexing, native drop intake and saved-file reveal to the existing Rust/Tauri workspace. This batch does not establish complete Guitar Pro parity. The accepted design and implementation plan are `docs/superpowers/specs/2026-10-15-gp8-file-library-design.md` and `docs/superpowers/plans/2026-10-15-gp8-file-library.md`.

## Interface and document behavior

The four Library sections follow the actual generated references and prompts versioned under `docs/design/reference-workstation`. One application-lifetime Library sits beside the existing editor/player. Opening a template/example creates a separate clean score with an immutable baseline and fresh user history. Normal file intake preserves original bytes and existing-tab aliases. Successful native open/save receipts authorize recents and later metadata enrichment; history-write failure remains separate from completed music I/O.

Schema3 adds the immutable baseline. Strict schema1/2 migration occurs after original-byte digest verification; the recovery envelope stays version1. Protected destinations include bundled Library content, its catalog/payload/index namespace, recovery files and existing original-score/backing sources. All sixteen Library IPCs are registered in production and diagnostic builds. No installer was executed.

## Verification

| Check | Observed result |
|---|---|
| Final frontend | `npx vitest run --maxWorkers=2 --testTimeout=15000`:1984 passed,1 existing skip,144 files |
| Resource scripts |24 passed,2 Windows file-symlink privilege skips |
| Native full suite |525 passed,9 existing ignored tests before the final isolated service correction |
| Native affected checks afterward |19 service tests passed;1 diagnostic serialization test passed; formatting passed |
| Production renderer and diagnostic builds |TypeScript/Vite passed; corrected native diagnostic build passed |
| Prepared diagnostic Library |All16 actual resource files verified against the authored inventory |

These overlapping groups are not summed. Default Vitest's five-second budget initially produced three timeouts and a downstream startup failure; a two-worker run retained one tuning timeout. Both affected files passed32 tests separately. The final full run used the explicit budget above without weakening assertions or changing global test configuration. Desktop CI now passes that same worker/timeout budget to Vitest through npm. The nine ignored native tests were not replayed; earlier accepted physical-audio/Long/recovery evidence remains separate.

Independent reviews accepted native integration31A8EC83, frontend integrationFA37F724, helper/resource integrationA01D5931, diagnostic serialization846286EC and worker protocol3ADED187. The latter two fixes were discovered by actual desktop execution: diagnostic JSON Value conversion reordered literal added-track identities, and metadata messages lacked the command tag required by alphaTab's additional worker listener. Each has a meaningful failing regression followed by passing affected tests. Production typed serialization was preserved; no track-ID migration was introduced.

## Actual Windows desktop runs

Original task-owned schema3 fixtures include multiple instruments, baseline and user edits, full redo, metadata unrelated to filenames, and an original embedded backing asset. No vendor score, private band file or live user catalog was used by this batch. Original input hashes were checked before and after execution.

Core and two clean restarts passed on diagnostic executable SHA-256 `46DB18B036E13ED2249E2AE5E5D9289E322F4A857C68D566B139B6B0045BBF36`:

- Actual personal-template capture preserves the source's dirty/redo history and native audio state.
- Independent fork Save/reopen, first edit/Undo and another fresh fork preserve the immutable baseline and exact template/source bytes.
- Every one of ten factory templates and three original examples opened canonically through the actual Library UI with notation and fresh history.
- Pin/unpin, missing-file Open/error/Retry, removal and persistence survived clean process restarts.

The corrected folder workflow passed on executable SHA-256 `67A0AA81F6F51A9FEE6DB1411E29C069C824290A381329F6ECA06C3AB463305D`:

- Actual native folder-picker Cancel preserved the catalog/workspace. Selecting the exact owned Unicode folder used the real native dialog; Windows control IDs1152/1 were observed.
- The real metadata worker indexed two scores. Searches by title, artist, album and track name found the expected score; indexed Open used normal document intake.
- Native project/owner/audio projections remained unchanged during search. The exact committed index survived a clean restart without Refresh.
- Actual native cancellation/root removal rejected late read/accept/finish calls. This is native admission coverage; it is not a delayed browser-worker scheduling receipt.

Root inspected one final eight-image set at960×720,1280×900 and1600×1000. Fresh visual reviewFCD6A561 accepted Welcome, Templates, long Unicode recents, actual Open error, missing file, Examples, empty Folders and populated Folders. No clipping/body overflow or material visual defect was found.

Retained local result hashes: Core `174D8EF8A033EC619A5FCEC2C3AB165DBB8FB37841F2BEC0A3F1D910C558347D`; restart `9AEF50A2D8FE24C2ADD54CC3BAF050B95BFAC5DEB9BA3300AA665C8F01763F78`; corrected Folders `B10F096B444C9A202883E236085A6C8DB18DC8A3A55A0DE14BCF0FE7F00D06AE`. Full commands, source fingerprints, owned process identities and failure receipts remain under `.analysis/parity` and the plan-scoped execution ledger.

Actual File → Open containing folder also passed on the corrected executable67A0AA81. The driver refused an already satisfied Explorer baseline before invoking the action, then observed a newly visible Windows Explorer window displaying the exact fixture parent with the original score selected. The native workspace, addressed document/history, owner and stable native audio fields remained exact. Cleanup requested closure only for the newly observed matching Explorer window and terminated only the captured diagnostic app instance. The result hash is `5C67D453D3E6CD70261EDE796FC52503E5DB0B21838F41D7BF7AE2C30BBD93DE`; script4F179203 and independent scoped review47EE1760 distinguish OS observation from launcher-request acceptance.

## Remaining acceptance

Update 2026-11-08 (THE-191): actual OS OLE drop delivery into the app is now shown on one Windows machine (Windows 11 build 26300, 150% scale). The helper was given its own non-activating source window and a held primary button, and `parity-file-drop` passed 6 consecutive runs (5 by the implementer, 1 by the controller), both groups including the replay check. The source is a helper-owned window, not Explorer or a person dragging; the app must be foreground. See `2026-11-08-desktop-driver-sweep.md`. The history below records the earlier failed helper attempts, which were a helper design fault (no window, so the OLE drag loop received no input), not a product drop failure. The first diagnostic helper attempt failed its PowerShell array guard before native entry; a one-line parser correction passed15 pure regressions. A subsequent OLE attempt hit its helper-only watchdog. One bounded helper-only experiment then replaced the STA timer with guarded background zero-motion input pulses. Its actual retry also timed out:63 input events were inserted, but the helper recorded zero Query/Feedback callbacks, zero Drop/Cancel returns and no native-call return. Stream insertion is not target delivery. No application groups passed and no product drop failure is established. Frozen helperE62909D4 and pinned driverD37BD6BA had independent static review; the failure receipt is `native-ole-drop-1792089725362-result.json`. That experiment is superseded by the THE-191 fix above. Tokens/expiry/overflow/retirement and sequential per-item intake have source/unit coverage; the driver's drop during a Library operation passed, while actual export and session-transition OS drops, dirty-document decisions, and macOS/Linux drop require separate proof.

Observed macOS/Linux containing-folder windows, an actual delayed browser-worker race, extracted shipping-package resources and current-platform CI remain separate gates. Source commit `764d926fbac039e844fbaa68e60969e2fcae2aaa` was pushed and the feature ref verified; released main remains `7fc41c773a1b016d7249ceb98ab7929fcca1ce8f`. Its [Actions run38787714198](https://github.com/KristjanKruusRIA/TabPlayer/actions/runs/38787714198) failed in four seconds: prepare-audio job116603918150 recorded no runner or steps, desktop was skipped, no artifacts were produced and the job-log endpoint returned404 BlobNotFound. The cause is unknown. Preparation-before-Cargo, canonical temporary-directory and bounded Vitest CI fixes address independently identified issues; neither this failure nor the earlier identical symptom establishes a source-test failure.

No full-inventory completion or new all-OS claim follows from this validation. W13 file associations remain separate.
