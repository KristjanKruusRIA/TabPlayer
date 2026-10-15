# Guitar Pro 8 File Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver W06/W07/W08/W09/W12/W14: exact factory/personal template forks, durable pinned recents, searchable local metadata, original offline examples, native file drops and containing-folder reveal.

**Architecture:** Extend the native project with an immutable baseline prefix, then compose isolated catalog/content/index producers behind fixed library contracts. Root joins them to the existing staged workspace intake and lifecycle; one controlled Library/Welcome surface follows generated visual references.

**Tech Stack:** Existing Rust 1.88/Tauri 2, React/TypeScript, alphaTab 1.8.4, serde/serde_json, sha2, base64, fs2, atomic-write-file and fflate. No new dependency.

**Spec:** [2026-10-15-gp8-file-library-design.md](../specs/2026-10-15-gp8-file-library-design.md). Also read accepted W05, recovery/session and reference-workstation contracts before root integration.

## Global Constraints

- Rust **1.88**, alphaTab **1.8.4**; new native saves use project schema **3** with required `baselineEdits`, preserving strict legacy schema1/2 reads and nested legacy recovery. No lossy GP/model-JSON baseline migration.
- New template/example forks have exact music/settings/assets, fresh IDs, `path=None`, no imported alias, clean user history and `canUndo=false`. Source sessions and bytes remain unchanged.
- One native catalog owner, one global scan, one file/worker parse in flight; no store/scan I/O under workspace/audio locks. Session freeze, existing activation fencing, Invalidate, source guards and modal/export ownership remain authoritative.
- Limits: recents100 unpinned/pins64/roots16/templates128; template512MiB each/4GiB referenced total; catalog2MiB; index50,000 files/32MiB aggregate; depth64; batches100; direct score64MiB/native project512MiB; metadata operations2MiB; worker8s, importer32MiB, decoded GPX64MiB, ZIP actual output32MiB per entry/64MiB aggregate and4096 entries; drop32 files/30s.
- The supplied collage and existing workstation tokens govern composition; root generates/inspects GenAI concepts before ANY new Library/Welcome/Templates UI implementation. Generated incidental copy/actions do not override the spec.
- User authorization and parallel execution are already supplied. Fresh artifact review and root integration replace human approval questions. This design author performs no product implementation.
- Do not alter the frozen258 baseline, private files, today's frozen recovery implementation, other workers' paths, or accepted audio evidence. Root owns all Git, builds/apps, complete suites and final overlay claims.

## Review Focus

1. Imported template forks must not activate their source tab, inherit authoring undo steps, lose added-track sound IDs or delete baseline-only assets — Tasks1/2/6/7.
2. A successful music open/save followed by failed catalog I/O stays successful; cancelled/invalid/stale intake never becomes a recent — Tasks2/6/7.
3. Removing/reconfiguring a root while a parse/search callback is pending cannot republish its files or read outside its native path scope — Tasks4/5/6/7.
4. Huge skipped backing strings, GPX expansion, ZIP aggregate size and non-abortable parser work must not freeze the editor or advertise complete indexing — Tasks4/7.
5. Dirty tabs, startup recovery, export leases and native shutdown retain their decisions/owner through multi-file drop, welcome, template capture and reveal failures — Tasks5/6/7.

## Ownership, interfaces and preflight

Create one SDD ledger for this plan only after the current recovery acceptance gate. Do not rerun context initialization. Root first stages/reviews Task1 contracts. Tasks2/3/4 then run on disjoint paths; Task5 follows root's reviewed GenAI concepts and can overlap accepted producer work. Root performs Task6 after producer acceptance and Task7 once the cohesive runtime is buildable. Workers freeze source/report hashes with meaningful RED/GREEN receipts, receive one fresh scoped review and relinquish paths. Workers do not run apps, whole suites or Cargo concurrently; root grants the Cargo slot explicitly.

| Owner | Exclusive paths |
|---|---|
| Root Task1 | `src/project.ts`, `src/engine.ts`, `src/controller.ts`, `src-tauri/src/project.rs`, `files.rs`, `workspace.rs`, `recovery.rs`; new `src/library/types.ts`, `src-tauri/src/file_library/types.rs`; shared schema/protocol fixtures and exact compile-required adaptations |
| Catalog Task2 | new `src-tauri/src/file_library/store.rs`, `src-tauri/tests/file_library_store.rs`, `file_library_process.rs`; no workspace/lib/session changes |
| Content Task3 | new `assets/library/**`, `scripts/prepare-library.mjs`, `prepare-library.test.mjs`; new `src/library/content.test.ts`; package/resource registrations remain root-owned |
| Metadata Task4 | new native `src-tauri/src/file_library/index.rs`, `metadata_input.rs`, tests `file_library_index.rs`, `file_library_metadata.rs`; new frontend `src/library/metadata.ts`, `metadata.worker.ts`, `metadata-runner.ts` and their tests; no engine/runtime changes |
| Library UI Task5 | new `src/library/LibraryController.ts`, `.test.ts`, `LibraryDialog.tsx`, `.test.tsx`, `library.css`; no App/main/workspace changes |
| Root Task6 | new native `src-tauri/src/file_library/mod.rs`, `commands.rs`, `src-tauri/src/intake.rs`, `reveal.rs`; `lib.rs`, `workspace.rs`, `session.rs`, `runtime.rs` destination seams only; new `src/library/bridge.ts`, `.test.ts`; `bridge.ts`, `WorkspaceController.ts`, `WorkspaceApp.tsx`, `App.tsx`, `main.tsx` and exact consumer tests; package/build/resource joins |
| Root Task7/script worker | new `tests/desktop/library-fixture.mjs`, `parity-file-library.mjs`; harness isolation/join only; new `docs/validation/2026-10-15-gp8-file-library.md`; proven progress-overlay rows only |

Native modules are private except the narrow library export needed by integration tests; root stages module declarations so isolated producers compile without registration. Root provides callable failing scaffolds only when needed for behavioral RED, rather than treating import failure as the complete test. Do not claim typecheck green while root's intermediate join is deliberately incomplete.

Task1 freezes the following shared DTOs (Rust equivalents use strict camelCase serde, required nullable fields and safe integers):

```ts
type LibrarySection='recent'|'templates'|'folders'|'examples';
type LibrarySource={kind:'recent';id:string}|{kind:'indexed';rootId:string;id:string}
  |{kind:'template';id:string}|{kind:'example';id:string};
interface LibraryMetadata {title:string;artist:string;album:string;trackNames:string[];metadataTruncated:boolean}
interface RecentEntry {id:string;path:string;metadata:LibraryMetadata|null;pinned:boolean;lastOpenedUnixMs:number;availability:'available'|'missing'|'unreadable'|'unknown'}
interface LibraryRoot {id:string;path:string;configurationRevision:number;availability:'available'|'missing'|'unreadable'|'unknown';indexedAtUnixMs:number|null}
interface LibraryContent {id:string;title:string;description:string;instruments:string[];origin:'factory'|'personal'|'example';license:string|null;sha256:string}
interface LibrarySnapshot {version:1;revision:number;welcomeSeen:boolean;recents:RecentEntry[];roots:LibraryRoot[];templates:LibraryContent[];examples:LibraryContent[];warning:string|null}
interface BundledLibrary {templates:LibraryContent[];examples:LibraryContent[]}
type LibraryChange={kind:'pin';id:string;pinned:boolean}|{kind:'removeRecent';id:string}
  |{kind:'removeRoot';id:string}|{kind:'renameTemplate';id:string;name:string}
  |{kind:'removeTemplate';id:string}|{kind:'welcomeSeen'};
interface LibraryQuery {rootId:string|null;text:string;sort:'title'|'artist'|'modified';offset:number;limit:100}
interface LibraryResult {id:string;rootId:string;path:string;metadata:LibraryMetadata|null;status:'indexed'|'metadataUnavailable'|'unavailable';modifiedUnixMs:number|null}
interface LibraryPage {indexRevision:number;total:number;rows:LibraryResult[];warning:string|null}
interface LibraryScan {jobId:string;rootId:string;configurationRevision:number;phase:'enumerating'|'reading'|'parsing'|'ready'|'failed'|'cancelled';discovered:number;processed:number;skipped:number;issues:string[]}
interface LibraryBatch {scan:LibraryScan;files:{fileId:string;filename:string}[];done:boolean}
type MetadataEdit={type:'setScoreInfo';title:string;artist:string}|{type:'setScoreMetadata';album:string}
  |{type:'setTrackInfo';track:number;name:string}
  |{type:'addTrack'|'addPitchedTrack'|'addPercussionTrack';name:string}|{type:'removeTrack';track:number};
interface MetadataInput {sha256:string;base:{kind:'blank';title:string;artist:string}|{kind:'file';bytesBase64:string};edits:MetadataEdit[]}
interface MetadataResult {sha256:string;metadata:LibraryMetadata|null;error:string|null}
```

`LibrarySnapshot.templates` includes read-only factory plus personal descriptors; IDs resolve against a native map, never by path concatenation. `MetadataInput.edits` is the ordered baseline-plus-applied metadata projection, not a new canonical project. No native asset payload or full history crosses this metadata IPC.

`NativeFileLibraryBridge` methods and literal IPC arguments:

| Method | IPC | Result |
|---|---|---|
| `snapshot()` | `file_library_snapshot` / no arguments | `LibrarySnapshot` |
| `retry()` | `file_library_retry` / no arguments | `LibrarySnapshot` |
| `change(expectedRevision,change)` | `file_library_change {expectedRevision,change}` | `LibrarySnapshot` |
| `pickRoot(expectedRevision)` | `file_library_root_pick {expectedRevision}` | `LibrarySnapshot|null` |
| `saveTemplate(expectedRevision,document,name)` | `file_library_template_save {expectedRevision,document,name}` | `LibrarySnapshot` |
| `ackMetadata(document,metadata)` | `file_library_metadata_ack {document,metadata}` | `LibrarySnapshot` |
| `stage(source)` | `file_library_stage {source}` | `DocumentIntake` |
| `scanBegin(rootId)` | `file_library_scan_begin {rootId}` | `LibraryScan` |
| `scanNext(jobId)` | `file_library_scan_next {jobId}` | `LibraryBatch` |
| `scanRead(jobId,fileId)` | `file_library_scan_read {jobId,fileId}` | `MetadataInput` |
| `scanAccept(jobId,fileId,result)` | `file_library_scan_accept {jobId,fileId,result}` | `LibraryScan` |
| `scanFinish(jobId)` | `file_library_scan_finish {jobId}` | `LibrarySnapshot` |
| `scanCancel(jobId)` | `file_library_scan_cancel {jobId}` | `void` |
| `search(query)` | `file_library_search {query}` | `LibraryPage` |
| `reveal(document)` | `file_library_reveal {document}` | `void` |
| `dropStage(dropToken,index)` | `workspace_drop_stage {dropToken,index}` | `DocumentIntake` |

Events: `file-library-changed` with `{revision:number,warning:string|null}` after catalog commit/warning, and `score-files-dropped` with `{dropToken:string,count:number}` from native OS capture. Neither event changes document/audio authority. Snapshot refresh uses a request sequence so old responses cannot overwrite newer revisions.

### Task 1: Root adds immutable native baseline and shared contracts

**Consumes:** accepted frozen recovery implementation and current schema2/session APIs. **Produces:** schema3 Project/ProjectView/ProjectInput, `ProjectSession::fork_project(&self)->Result<Project,String>`, `DocumentWorkspace::template_project(&self,address:&DocumentRevision)->Result<Project,String>`, `stage_fork(&mut self,project:Project)->Result<DocumentCandidate,String>`, private candidate-purpose tracking, the DTOs above and shared migration fixture `tests/project-baseline-protocol.json`.

**Files:** root shared paths above; new `src-tauri/tests/project_baseline.rs`, `src/project-baseline.test.ts`; adapt `project_recovery`, `project_files`, `project_v2`, `recovery_protocol` and exact existing schema assertions.

- [ ] Write `template_fork_has_exact_immutable_baseline_and_no_user_history`: imported multitrack source with added-track sounds/mixes/engraving, backing, applied music and a saved-other/redo branch. Assert source checkpoint byte equality, fork `baselineEdits=old baseline+applied`, `edits=[]`, only reachable assets, clean pathless session, no undo/redo. Canonical replay must equal source notes/settings and exact track identities.
- [ ] Write `first_user_edit_undo_redo_never_crosses_baseline`: edit, undo to baseline, redo, Save As/reopen, branch/undo/redo, and saved checkpoint with baseline-only plus saved-only/redo-only assets. Assert baseline remains immutable and original bytes/hashes unchanged. Clean-session projection must retain a pathless nonempty baseline instead of classifying it as a disposable blank.
- [ ] Write shared legacy1/2/native3/old nested-recovery fixtures: unknown/future/invalid fields reject; legacy gets empty baseline, preserves dirty/cursor/saved/redo; original file digest remains the original-byte digest until successful schema3 save. Include baseline setBacking(null) over embedded backing and settings-only replay to prevent backing resurrection.
- [ ] Run focused native `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test project_baseline --test project_recovery --test project_files --test recovery_protocol` and frontend `npx vitest run src/project-baseline.test.ts` to meaningful RED, with root-exclusive Cargo. Implement the schema/prefix logic and fork-purpose seam. Audit every semantic `project.edits` consumer; use concatenation for musical replay and preserve user-only undo/dirty semantics.
- [ ] Run affected suites to GREEN, typecheck, `cargo +1.88.0 fmt --manifest-path src-tauri/Cargo.toml --check`. Freeze exact contracts/report hashes and obtain fresh review before producer dispatch. Root makes the scoped commit; no whole app launch at this intermediate stage.

### Task 2: Catalog worker persists recents and personal templates

**Consumes:** Task1 DTOs/schema3, existing `files::write_bytes`, fs2/atomic-write-file and path identity helpers exposed by root as necessary. **Produces in store.rs:** `LibraryStore::acquire(directory:PathBuf,bundled:BundledLibrary)->Result<Self,String>`, `snapshot(&self)->Result<LibrarySnapshot,String>`, `change(&mut self,expected:u64,change:LibraryChange)->Result<LibrarySnapshot,String>`, `add_root(&mut self,expected:u64,path:PathBuf)->Result<LibrarySnapshot,String>`, `put_template(&mut self,expected:u64,name:String,project:Project)->Result<LibrarySnapshot,String>`, `template_project(&self,id:&str)->Result<Project,String>`, `ack_recent(&mut self,receipt:RecentReceipt)->Result<LibrarySnapshot,String>`, `ack_index(&mut self,root_id:&str,configuration_revision:u64,indexed_at_unix_ms:u64)->Result<LibrarySnapshot,String>`, `retry(&mut self)->Result<LibrarySnapshot,String>`. `template_project` resolves personal entries only; root resolves immutable bundled IDs separately. Root stages exact private catalog/receipt structs before work; `RecentReceipt {path:PathBuf,digest:String,opened_at_unix_ms:u64,metadata:Option<LibraryMetadata>}` always represents a completed open/save. Tests inject a small literal BundledLibrary; Task3 content is not an implementation dependency.

- [ ] Write `catalog_reopens_pins_missing_entries_and_removes_only_the_requested_id`: persist/restart, canonical alias dedupe preserves pin/ID, copied paths remain distinct, pin/unpin/remove missing, pinned64/unpinned100 ordering/eviction and stale expectedRevision conflict leave prior bytes correct. A failed acknowledged-open write queues bounded path-deduplicated receipts; Retry durably merges them once, while stale pin/config/template mutations never auto-commit.
- [ ] Write `explicit_recent_remove_supersedes_older_pending_receipts`: persist A, queue a later successful-open/save receipt for A through a failed history write, successfully Remove A, then Retry/restart and assert A remains absent. Repeat with a canonical alias. Failed Remove preserves prior catalog and queue so Retry still applies that receipt; a genuinely later successful open/save may re-add A. Implement this ordering inside `change(removeRecent)`: commit removal before retiring all matching already-pending receipts under the existing store mutex; no tombstones. Metadata enrichment cannot create an absent recent.
- [ ] Write `template_manifest_publication_is_atomic_and_source_independent`: exact full project/assets roundtrip and Unicode duplicate names; payload/manifest/sharing failure, restart between phases, removal/retry, corrupt/future catalog and 2MiB/128/512MiB/4GiB limits. Removal cannot resurrect after reload. Inject real filesystem failures plus owned temp/unknown-near-match/symlink/directory fixtures; deletion debt blocks further payload creation and attempts all eligible obsolete files.
- [ ] Write `library_os_lock_releases_after_child_exit`: second process cannot read/write while first owns lock, succeeds after owner termination; no arbitrary path joins or recursive cleanup. Catalog absent read is nonmutating; corrupt bytes remain exact. A committed recent with cleanup warning stays acknowledged and retryable.
- [ ] Run `cargo +1.88.0 test --manifest-path src-tauri/Cargo.toml --test file_library_store --test file_library_process` to RED under root's Cargo slot. Implement only the store and tests, using current-only manifest truth and bounded payload-before-catalog publication. Do not add UI/runtime/native commands or new dependencies.
- [ ] Run selected tests GREEN and scoped rustfmt check, freeze report/source hashes and relinquish. Fresh review covers failure commitpoints and deletion namespace; root accepts/commits only these paths.

### Task 3: Content worker authors factory templates and offline examples

**Consumes:** Task1 schema3 and existing public edit types. **Produces:** `assets/library/manifest.json` format `TabPlayerBundledLibrary` version1 with immutable factory/example descriptors and payload relative paths/hashes, ten factory `.tabplayer` files, three original example `.tabplayer` files, `assets/library/README.md`, `CC0-1.0.txt`; `prepareLibrary({source,destination,checkOnly})` in the new script. Generated build output belongs under existing prepared public/resource paths chosen by root, not ad hoc committed binaries.

- [ ] Write content tests requiring the exact ten template categories and three ≥8-measure example ensembles from spec. Canonical build must verify actual string counts/programs/percussion/pitched staves, nontrivial notes/rhythms in examples, band four tracks, exact descriptor hashes and no absolute personal path/network URL/backing/vendor bytes.
- [ ] Run `npx vitest run src/library/content.test.ts` and `node --test scripts/prepare-library.test.mjs` to RED. Author original literal score data and dedication; factory templates use immutable baseline configuration, user history empty. Examples use real playable content and instantiate through Task1 fork semantics.
- [ ] Implement preparation/check-only behavior: validate manifest version/known relative paths/strict hashes, copy only known owned resources, reject path traversal/symlinks/duplicate IDs and missing/stale payloads, preserve unrelated destination files. No network fetch or private fixtures.
- [ ] Run both suites GREEN; provide source hashes and expected packaged file inventory. Root separately joins predev/prebuild/copy-notices and shipping resource verification so workers do not edit package.json or shared scripts.
- [ ] Freeze authored-content/license/report hashes and obtain fresh review for originality claims, playable fidelity and offline inventory before root acceptance/commit.

### Task 4: Metadata worker implements cancellable native index and pure projection

**Consumes:** Task1 DTOs; Task2 accepted catalog root snapshots. **Produces native:** `MetadataInputReader::read(path:&Path)->Result<MetadataInput,String>` (bounded index projection only); `LibraryIndex::new(directory:PathBuf,roots:Vec<LibraryRoot>)->Result<Self,String>`, `begin(root:LibraryRoot)->Result<LibraryScan,String>`, `next(job_id:&str)->Result<LibraryBatch,String>`, `read(job_id:&str,file_id:&str)->Result<MetadataInput,String>`, `accept(job_id:&str,file_id:&str,result:MetadataResult)->Result<LibraryScan,String>`, `finish(job_id:&str,current_root:&LibraryRoot)->Result<IndexCommit,String>`, `cancel(job_id:&str)->Result<(),String>`, `retire_root(root_id:&str)->Result<(),String>`, `search(query:&LibraryQuery)->Result<LibraryPage,String>`. `IndexCommit {root_id,configuration_revision,indexed_at_unix_ms,index_revision}` is returned only after atomic publication. Root holds the short native library-operation gate across current-root recheck plus finish, or across root configuration retirement; `retire_root` runs only after durable catalog removal and deletes only that derived cache. Failed removal leaves the prior index intact with the old job cancelled. No workspace/audio lock or parser execution enters this gate. The index owns cancellation/read state, never the workspace.

**Produces frontend:** `projectMetadata(base:LibraryMetadata,edits:readonly MetadataEdit[]):LibraryMetadata`, `extractMetadata(input:MetadataInput):MetadataResult`, and `createMetadataRunner():{run(input:MetadataInput,signal:AbortSignal):Promise<MetadataResult>;dispose():void}`. Worker protocol request/result include a monotonically increasing request ID and SHA receipt. No canonical engine changes.

- [ ] Write `metadata_projection_matches_canonical_applied_score`: both blank/file bases; seven commands in mixed baseline+user order, empty replacements/default Instrument, rename/remove bounds, track additions/removals, and advanced lyrics/harmony/clipboard/measure histories that leave indexed fields unchanged. Compare against canonical buildDocument, including schema1/2 migration; do not use the same projection to build the expected result.
- [ ] Write native streamed projection tests with a large generated/skipped asset string, malformed/truncated JSON, future version, bounded relevant fields/operations and corrupt base; no decoded backing retained. Directory tests cover overlapping roots, depth/file/index caps, UTF paths, symlinks, directory permission failure, file change during read and revalidation outside-root; retain previous index on cancellation/failure.
- [ ] Write `zip_admission_counts_actual_expansion_before_import`: include three entries that each inflate to 24 MiB while declaring one byte, an actual aggregate above 64 MiB with individually sub-32-MiB entries, an actual per-entry output above 32 MiB, and declared/output mismatches. Assert rejection before a spied alphaTab importer is called, alongside oversized declarations/4096-entry/unknown-size cases. Implement bounded-chunk fflate streaming admission that counts and discards actual output, aborts immediately on breach, and invokes alphaTab only after the complete pass succeeds; header-only checks are insufficient.
- [ ] Write worker deadline/cancellation tests retaining declared GPX expansion, 64 MiB compressed-input limit, 8s deadline across admission+import, abort during expansion or parsing, and stale messages from a retired worker. A worker failure yields explicit metadataUnavailable; successful title/artist/album/track search remains proven with real imports. No model-heap-cap claim.
- [ ] Write `removed_root_or_retired_job_cannot_publish_or_read`: defer read/parse completion, retire/remove/reconfigure, then deliver old accept/finish and search response; all reject/are ignored without recreating rows. Test query all-token Unicode matching, All folders/single root, stable sorting, 100-row pages and index revisions.
- [ ] Run `npx vitest run src/library/metadata.test.ts src/library/metadata-runner.test.ts` and selected native `--test file_library_index --test file_library_metadata` to RED, then implement producer paths. Use native cooperative cancellation and atomic completed-index publication; skip unsupported source strings without treating them as canonical validation. Run GREEN, freeze/review and relinquish. Root coordinates the single Cargo slot.

### Task 5: UI worker builds Library/Welcome from generated concepts

**Prerequisite:** root independently reviews this design/plan, generates the four Welcome/Recent, Templates, Folders and Examples concepts using the spec prompt, inspects them, and freezes their paths/hashes. Until then no UI product implementation. The worker reads Impeccable craft-floor immediately before edits and uses the existing workstation tokens.

**Consumes:** Task1 types, Task4 `MetadataRunner`, controlled `NativeFileLibraryBridge`, and root callbacks `openSource(source:LibrarySource):Promise<boolean>`, `saveTemplate(name:string,expectedRevision:number):Promise<LibrarySnapshot>`. **Produces:** `LibraryController.create(bridge,runner,callbacks):Promise<LibraryController>`, `getState`, `subscribe`, `section`, `query`, `select`, `open`, `change`, `pickRoot`, `saveTemplate`, `scan`, `cancelScan`, `refresh`, `dispose`; methods return Promise for async actions and observe every background rejection. `LibraryUiState` has snapshot, section, query, page, selectedId, scan, pending, error, notice. `LibraryDialog({controller:LibraryController,welcome:boolean,onClose:()=>void}):ReactElement` uses one external-store subscription and controlled native callbacks, no workspace/player creation.

- [ ] Write UI/controller RED cases for all four sections, durable pin/unpin/missing removal, real metadata result Open, factory/personal create/rename/remove, original examples, folder add cancel/refresh/cancel/failure and limit issue. Verify pending errors preserve list/query/name drafts and every mutation uses current expectedRevision. Do not mock success as a visual-only action.
- [ ] Write async ownership tests: opening closes only after true canonical commit; stale snapshot/query responses cannot overwrite newer catalog/index revisions; removed roots retire workers/native jobs before UI reports removal; dispose aborts scan/listeners and ignores late callbacks. Music callbacks are invoked only for explicit Open/Save as template.
- [ ] Write focus/keyboard cases: initial search/useful heading, Tab trap, Escape disabled while an open/template commit lease is pending, return focus, section-switch draft retention, long Unicode paths, empty/missing/error states and keyboard activation once. Search debounce150ms; native requests use100-row pages and no parse per keystroke.
- [ ] Run `npx vitest run src/library/LibraryController.test.ts src/library/LibraryDialog.test.tsx` to RED. Implement the reviewed generated composition, factual counts/errors and mounted drafts with existing CSS tokens; root owns App/main/session wiring. Do not introduce fake thumbnails/meters/downloads, broad settings or extra lifecycle authority.
- [ ] Run focused suites/typecheck GREEN (or report only root-owned transitional compile errors precisely); freeze source/concept/report hashes. Fresh reviewer compares actual UI code and receipts to concepts/spec; root accepts before runtime integration.

### Task 6: Root joins library, common intake, native drop and reveal

**Consumes:** accepted Tasks1–5. **Produces:** all literal IPCs/events above in production and desktop-test registrations, existing picker/common path helper, root source adapters and application-lifetime Library controller. Root exposes a narrow native successful-intake receipt seam rather than asking the frontend to assert successful I/O.

Root keeps a bounded private successful-receipt map keyed by document ID and acknowledgment revision. `ackMetadata` must match the still-open document/revision and that receipt before enriching an existing recent entry; it cannot create an absent recent or history for arbitrary paths or edits. It preserves the original successful-operation time. A stale/rejected metadata acknowledgment affects only Library feedback, never the already-successful music operation. Final index publication calls `ack_index` under the library-operation gate; a failed timestamp/catalog acknowledgment reports a Library warning and does not misreport the completed index write as music failure.

- [ ] Write native/controller RED cases: recent/index/picker/drop share `read_candidate` semantics; canonical failure cancels candidate and origin receipt; successful add/activate/save acknowledges one recent afterward; cancelled picker/save, stale address and failed commit acknowledge none. Inject catalog failure after actual music success and assert workspace/save remains successful with separate warning/Retry.
- [ ] Implement root `intake::read_candidate(path:PathBuf,workspace:&Mutex<DocumentWorkspace>)->Result<DocumentIntake,String>` by moving current behavior without changing source guards or filters. Add `WorkspaceController.openSource(source,libraryBridge):Promise<boolean>` and `openDrop(dropToken,count,libraryBridge):Promise<{opened:number;issues:string[]}>` using one transition and existing private add path; process drop sequentially with per-item cleanup and no source replacement. Preserve editor/export/session conflict behavior.
- [ ] Implement template capture using the existing editor operation lease and `DocumentRevision` checks, cloning a native fork project before I/O. Library stage resolves only native IDs; Fork creates a separate tab even while the original imported path is open. Save/export destination admission protects app-owned content paths while retaining source/hash/cross-document protections. Add read-only reveal native helpers and fake-launcher platform tests for Unicode/spaces/commas/UNC/missing/launch failure, without shell strings.
- [ ] Install one native window drop handler and one root event listener, not inside keyed App. Native short-lived tokens hold OS-provided paths, max32/expiry30s, one-use item indexes; unsupported files/directories and busy startup/shutdown/modal/export produce visible issues. Retire all tokens/jobs on shutdown; stale native metadata/search callbacks cannot mutate catalog or recovered workspace. Join the short library-operation gate for root removal/configuration and final index publication; a failed catalog removal keeps old cache data and does not allow the cancelled job to resume.
- [ ] Join File commands and one controlled Library overlay in WorkspaceApp without replacing App/player. Welcome appears only after startup resolves, when appropriate; catalog welcomeSeen acknowledgment follows actual display/dismissal and remains separate from session preference. Join new content prepare/package checks. All new commands inspect lifecycle admission for document actions; scans remain off workspace/audio locks and preserve ordinary playback state.
- [ ] Run focused App/WorkspaceApp/controller/bridge/native intake/history/recovery tests, typecheck and build. Compare before/after owner, native generation, time, phase, loop, project/history/settings and recovery revision through search/pin/reveal/cancel. No new audio recording unless an actually changed audio path creates a specific unresolved question. Freeze cohesive source, obtain independent runtime-contract review, then root commits.

### Task 7: Root proves complete file workflows, shipping data and visual acceptance

**Consumes:** cohesive accepted runtime, generated concepts and original fixture content. **Produces:** immutable validation report/receipts and only evidence-supported parity-overlay changes.

- [ ] Create small original fixture files and a native acceptance script using fresh absolute session/library isolation. It saves and reopens a multitrack personal template, verifies clean baseline/no source mutation and independent first-edit undo, then restarts and proves pin/unpin/missing removal. Search a configured folder by artist/album/track name unlike its filename and open the correct result; restart proves index persistence.
- [ ] Exercise actual native OS file drops with one dirty tab and mixed valid/invalid/duplicate items; verify original dirty history, successful tabs, errors and candidate cleanup. Cover busy modal/export/shutdown rejection, stale token, root removal during slow worker and cancel without stale publication. Tests may launch controlled diagnostic app instances only through root's existing harness.
- [ ] Verify all factory/example payloads offline in frontend/native package resource tests and exact content hashes; open every bundled item, not only catalog labels. Run actual containing-folder launch on Windows and obtain macOS/Linux desktop receipts; build/unit tests alone leave those platform-specific reveal claims incomplete.
- [ ] Perform one batched native visual/keyboard inspection at960×720/1280×900/1600×1000 for Welcome/Recent/Templates/Folders/Examples and meaningful error/missing/long-list states. Compare with generated images and supplied collage. Fix material defects together, confirm once if warranted, and have a fresh reviewer inspect loaded nonblank screenshots and behavior receipts. Do not repeat accepted W05/recovery audio captures merely to refresh evidence.
- [ ] Run one appropriate joined frontend/resources/typecheck/build pass and serialized native full suite/fmt after all mutations are joined; rerun only affected suites after warranted corrections. Audit complete diff, persisted data namespaces, schema3 legacy files/recovery, drop/native owner and package resources. Root writes `docs/validation/2026-10-15-gp8-file-library.md`, records exact hashes/commands/limits, and updates W06/W07/W08/W09/W12/W14 only to the level proven, preserving separate W13 and all other open rows.
- [ ] Root commits/pushes the cohesive reviewed feature branch when authorized repository checks pass, records remote/CI state, and leaves the overarching parity goal active until every full-inventory requirement is proven. Never mark this batch or any all-OS capability complete from a plan, mockup, passing projection test or a Windows-only receipt.

## Self-review and execution handoff

Coverage: immutable baseline/legacy recovery→Task1; durable recents/templates→Task2; factory/original examples/offline packaging→Task3; root scope/metadata/cancellation/search→Task4; generated Library/Welcome and all user actions→Task5; staged intake/acknowledgments/drop/reveal/destination admission→Task6; real desktop/process/platform/visual/shipping evidence→Task7. The five review-focus classes each have explicit tests in their owner tasks. Task interfaces use the same DTO/method/IPC names throughout; source-path and shared-runtime edits remain root-owned.

The selected execution method is the user's existing parallel subagent implementation in this chat with independent reviews. Root first reviews this design/plan, resolves any design findings, generates the new-view concepts and dispatches exact producer ownership after the current recovery gate. No additional user approval question is required.
