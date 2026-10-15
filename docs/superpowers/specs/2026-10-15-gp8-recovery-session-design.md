# Guitar Pro 8 recovery and session design

Date: 2026-10-15. Architectural delivery for W10/W11, after the accepted W05 document-tabs delivery. Discovery baseline: released `7fc41c773a1b016d7249ceb98ab7929fcca1ce8f`; W05 contract stage: `925c6ea`. W05 runtime is still being implemented when this design is written. Its accepted spec/plan is authoritative where current source remains a singleton. This is a proposal for independently reviewed implementation, not an implementation or acceptance claim. The standing full-goal instruction authorizes changes and parallel workers without additional approval questions; root and a fresh independent reviewer review these artifacts first.

## Intent, evidence and limits

Restore a musician's committed unsaved work after process failure, including every valid document, its undo/redo history and embedded inputs. Restore the last clean session's ordered tabs and editor locations when the preference is enabled. The exact original baseline acceptances are:

- **W10:** "Crash with unsaved edits and restore all documents from valid backups."
- **W11:** "Restart and restore document tabs and location according to preference."

Evidence: `.analysis/parity/next-document-workflow-audit.md`; `docs/validation/2026-10-15-gp8-parity-baseline.json` W10/W11; accepted `2026-10-15-gp8-document-tabs-design.md` and its plan; current `ProjectSession`, `Project`, `StoredAsset`, `files.rs`. Graph/index tools were unavailable; scoped source inspection was used. In particular, `ProjectSession::stored_project` deliberately compacts at the cursor, `new` marks all supplied edits saved, and `ProjectView` excludes asset bytes. None is a recovery representation. The saved command vector can describe a different branch from the current history and must not be replaced by a saved cursor.

Fixed assumptions: one editor window and one recovery writer per application-data directory; restore starts stopped; unsaved recovery is offered independently of the clean-session preference. The new **Restore previous session** preference defaults to **true**. A checkpoint is a periodic backup, not a promise that the last keystroke survived. Show its recorded time and distinguish pending/failed backup from acknowledged backup. Preserve the approved three columns, slate/cream/lime visual language and physical instrument artwork.

Native project schema **2**, alphaTab **1.8.4**, Rust **1.88** remain fixed. Ordinary `.tabplayer` saves, schema-1 migration, source guards and compact disk redo semantics stay unchanged. No templates, recent/pinned library, broad preferences, new score serialization, original-GP8 execution or physical-OS equivalence claim. W05 stable IDs, revisions, one active player, operation leases, exports, modal policy, Close All and the narrow audio activation fence remain authoritative, including the atomic Invalidate exception.

## Alternatives and chosen boundary

1. **Chosen: native full-session envelope, a small atomic commit manifest and one bounded writer.** Reuses native project validation and atomic writes, retains complete history, and makes close/discard retirement explicit. Two authorized generations provide payload-corruption fallback without guessing which discarded work is still wanted.
2. Compact ordinary saves plus frontend view state are smaller but lose redo, redo-only assets and the saved comparison. Reject. Frontend score/model JSON and `ProjectView` must never be recovery truth.
3. A command journal or content-addressed asset database would reduce repeated large writes but adds replay, garbage collection and cross-file commit policy. Defer; one self-contained envelope is sufficient for this delivery, with measured bounds and visible failure when the bound is exceeded.

For capture, a full `Project::clone` under the workspace lock is simplest but copies base64 backing/source strings and can delay W05's workspace-only Invalidate. Holding the lock through serialization is worse. Choose only **immutable byte-string sharing**: change `BaseDocument::File.bytes_base64` and `StoredAsset.bytes_base64` to `Arc<str>`, enable the existing serde dependency's `rc` feature, and adapt construction/decoding at those exact sites. JSON remains an identical string. `ProjectSession::snapshot`, `stored_project`, recovery capture and existing Project/StoredAsset clones then share these two payload fields; history/asset maps remain ordinary owned collections. No blanket Arc/history/workspace refactor and no performance claim before measurement. Capture still copies command metadata under the workspace lock; record its measured duration and retain a latched large-asset Invalidate regression.

One narrowly justified new dependency is `fs2 = "=0.4.3"` for an OS-released exclusive advisory lock on supported desktop platforms. Rust 1.88 has no usable stable standard-library file-lock API; a PID file or create-new sentinel alone cannot safely distinguish a crashed writer from a live/reused PID. Root verifies this dependency builds on Rust 1.88 before using it. Do not add a single-instance/plugin framework or platform-specific lock implementation alongside it.

## Native persisted types and ownership

All native persisted structs use camelCase, strict unknown-field rejection and explicit version/format validation. The full envelope stays native; IPC only returns normal addressed snapshots and recovery summaries.

```rust
// project.rs: lossless in-memory/session interchange, not a normal file format.
pub struct ProjectCheckpoint {
    pub project: Project,             // COMPLETE current branch and all retained StoredAssets
    pub cursor: usize,
    pub saved: Vec<EditCommand>,      // exact comparison, possibly a different branch
    pub path: Option<PathBuf>,
}
impl ProjectSession {
    pub fn checkpoint(&self) -> ProjectCheckpoint;
    pub fn from_checkpoint(value: ProjectCheckpoint) -> Result<Self, String>;
    pub fn saved_checkpoint(&self) -> Result<ProjectCheckpoint, String>;
}
// recovery.rs; ordered documents is the tab order.
pub struct RecoveryDocument {
    pub document_id: String, pub revision: u64,
    pub session: ProjectCheckpoint,
    pub imported_path: Option<PathBuf>,
    pub saved_file_sha256: Option<String>,
    pub view: DocumentViewState,
}
pub struct RecoveryEnvelope {
    pub format: String,               // "TabPlayerRecovery"
    pub version: u32,                 // 1
    pub epoch: u64, pub generation: u64,
    pub captured_at_unix_ms: u64,      // display only, never ordering authority
    pub active_document_id: Option<String>,
    pub documents: Vec<RecoveryDocument>,
}
pub struct CheckpointRef { pub generation: u64, pub sha256: String }
pub enum SessionLifecycle { Running, Clean }
pub struct RecoveryManifest {
    pub format: String,               // "TabPlayerRecoveryManifest"
    pub version: u32,                 // 1
    pub epoch: u64, pub lifecycle: SessionLifecycle,
    pub current: CheckpointRef, pub previous: Option<CheckpointRef>,
}
pub struct SessionPreferences { pub version: u32, pub restore_previous_session: bool }
```

`DocumentViewState` is the W05 shape, with a matching native strict serde DTO added now: target/selectedString/selectedNoteIndex/zoom/trackView/instrumentVisible. It is a location sidecar, never an edit. Numeric revisions/generations/epochs are nonnegative safe integers <=9007199254740991, with checked increments before mutation. Lifecycle wire values are `running`/`clean`. Paths stay native PathBuf/String as incumbent APIs require; IDs are opaque, unique, nonempty W05 IDs. Restore preserves document IDs/revisions but creates a fresh activation ID; new IDs probe existing membership to avoid process-ID/sequence reuse collisions. No candidates, activation IDs, clipboard, dialog drafts, musical selection, transport clocks, play state, loop playback or export jobs are persisted.

`checkpoint` copies all retained assets, not just applied or redo-referenced ones. `from_checkpoint` validates Project/schema/engine/base hash/all asset hashes, cursor<=history length, every saved command and its asset references; it rebuilds native asset metadata and restores cursor/saved/path exactly. It does not call `new` and silently mark the applied prefix clean. `saved_checkpoint` uses the immutable base plus saved commands, retains only their assets, sets cursor to saved length and saved to the same commands: it implements an explicit Discard on clean window exit, not crash recovery. An undone saved branch therefore remains reconstructible.

Workspace entries retain `saved_file_sha256` from the exact native file bytes read or successfully written, not a reread at checkpoint time. None for an unsaved/import-only document; Some is required when path is Some. Existing open parses and hashes the same read buffer; existing save returns/records the digest only after its atomic write succeeds. Add read_project_with_digest/write_project_with_digest wrappers while retaining incumbent read_project/write_project signatures; do not reread between parsing and digesting. Keep imported intake alias separately, as W05 requires. Source/backing origins inside native base/assets remain exact, including redo-only origins.

## Files, ownership and atomic publication

Production uses `app_data_dir()` as the session directory. Only with both the `desktop-test` feature and `TABPLAYER_DESKTOP_TEST=1`, require `TABPLAYER_TEST_SESSION_DIR` to select an absolute isolated test session directory; a missing/relative value fails diagnostic startup instead of touching production recovery. The production build ignores it. WebView dataDirectory alone does not isolate native app data. Under that session directory, `recovery-v1/` contains: `writer.lock`, `manifest.json`, `checkpoint-<generation>.json`. Preferences live at `session-preferences.json` in that same session directory. Native startup acquires and holds `writer.lock` for the process lifetime before reading/writing these files or constructing the mutable workspace. The OS releases it on crash. Use `FileExt::try_lock_exclusive`, retaining the open file handle; an empty lock file remaining after a crash is harmless. A second process using the directory receives "TabPlayer is already using this session. Close the other window first." and does not read/claim/write recovery or preferences. Never delete/steal locks by PID or timestamp; isolated test profiles use separate directories.

One worker writes a new immutable checkpoint using existing AtomicWriteFile, streaming JSON through a byte-counting SHA-256 writer. After successful payload commit, atomically replace manifest.json; only that second commit acknowledges a checkpoint. The new manifest refers to the new payload and, for an ordinary checkpoint only, the previously acknowledged current payload in the **same epoch**. A crash before manifest commit leaves the old manifest authoritative; a crash afterward sees the new complete payload. Unreferenced temporary/new files are not startup candidates. Keep at most the current and previous referenced payload after successful publication; garbage collection is confined to this owned directory, never source/user files. Before explicit startup resolution replaces invalid evidence, copy the old manifest and its recognized affected payload into `diagnostic/` using atomic writes. When a corrupt manifest cannot identify a reference, preserve up to three extant recognized checkpoint files (the previous normal pair plus an interrupted write), ordered by numeric filename; never use these files as automatic restore candidates. Keep one diagnostic set; replacing an older set requires a later explicit startup resolution. Diagnostic-copy failure prevents resolution and preserves originals. Only after the new Running manifest commits may normal cleanup retire originals. A crash while copying diagnostics therefore leaves the old manifest and payloads intact. Unknown files are never deleted.

Validate manifest before selecting a payload: exact format/version, safe counters, digest syntax, previous generation < current generation and filename derived solely from the integer. Verify payload digest, envelope version/epoch/generation and size before use. On current payload unreadable/truncated/hash mismatch, try only manifest.previous of the same epoch and disclose the earlier checkpoint time. If manifest itself is corrupt/future, do not scan guessed orphan generations: show the error, preserve artifacts, permit explicitly starting a new session, and never silently overwrite evidence. Future envelope versions reject as a whole. This conservative manifest failure intentionally trades automatic recovery for preventing discarded work from reappearing.

Decode a validated envelope header with `documents: Vec<serde_json::Value>`, then validate each strict RecoveryDocument separately. Decode each entry through a strict raw document with `view: serde_json::Value`; parse/repair that view separately so a malformed view cannot exclude valid music. Independent valid entries remain recoverable when a digest-valid document has invalid native/schema/view data; an invalid view alone resets to the W05 initial view and reports that repair. Duplicate document IDs invalidate every colliding entry, not an arbitrary winner. Invalid music entries are reported with index/title when available; no frontend publication of invalid entries. Keep valid tab order; if active is absent/invalid, use the first valid entry; if none, offer a fresh blank. Candidate previews build each applied score through the existing frontend engine before restore publication; failed build excludes only that document and is reported. Native redo remains full and follows existing validated redo preview semantics.

## Bounded checkpoint work and retirement barriers

Native committed changes schedule backups: document add/edit/undo/redo/save, activation/order and acknowledged view changes. Candidate staging/failure, dialog drafts and audio status do not. Use a **2-second quiet period with a 10-second maximum wait** from the first pending change. There is one in-flight capture/write and one dirty/latest-revision marker, not a queued snapshot per edit. After an in-flight write completes, capture the newest pending state. A native monotonic workspace checkpoint revision changes on those events independently of each document revision. Checkpointing never increments document revision, marks saved or changes user paths.

Capture on a blocking worker with the workspace lock held only while cloning native state and shared byte references; serialize, hash, validate decoded assets and perform I/O after releasing it. Never hold the audio access gate or service/control/cache locks during backup work; never call from the audio callback. Limit each encoded checkpoint to **512 MiB**, including recovery loading via a bounded reader; streaming stops before exceeding it. One capture and one decoder buffer/asset at a time prevents a per-tab worker fan-out. Exceeding the limit keeps live work intact and the previous committed checkpoint, reports "Recovery backup exceeds 512 MiB. Save your work explicitly.", and must not show a fresh success time. The worker's memory bound is existing live assets plus shared snapshot metadata and bounded streaming/read buffers; deserialize may hold one encoded envelope up to the cap, and decode validates one asset at a time. Disk use is at most two normal payloads, one in-flight payload, plus at most three payloads in one retained diagnostic set. No artificial limit is imposed on normal saves or live editing by this recovery cap. If the cap blocks clean shutdown with restoration enabled, show the recovery error and explain the available escape: save explicitly, turn off Restore previous session, then close; the empty Clean envelope still must commit. Never imply that explicit Save alone can make an oversized session checkpoint fit.

An ordinary edit can occur during a writer job; its older acknowledged result is truthful but leaves the newest revision pending. **Removal/discard cannot:** tab close, Close All, explicit startup Discard and successful clean shutdown require a serialized retirement barrier. Pause checkpoint dispatch, drain the one prior job without holding workspace/audio locks, and freeze new document/view mutations under W05 transition busy state. Prepare the prospective state without changing live sessions. Write it in a checked new epoch with previous=None; commit its manifest before publishing removal/acknowledging close. If commit fails, keep all tabs/discarded edits live, report failure and permit Retry/Cancel; no window destruction. Earlier explicit Save operations may remain saved, as in W05. Resume pending backups on cancellation/failure. A later worker from the old epoch cannot publish after the barrier.

For ordinary tab Close/Close All, prospective state uses W05's exact successor/last-blank rules. A successful close is therefore durable against fallback. A crash before its manifest commit can restore the old tabs because close was not acknowledged; afterward it cannot. If the new epoch's only payload is corrupt, do not fall back across retirement to resurrect discarded work. This is the explicit failure tradeoff. Autosave write failures otherwise preserve the acknowledged pair and live state; status exposes the error and a Retry action, and the next committed change can schedule another attempt.

## Startup and clean exit

Startup holds the ownership lock and offers no editable App until recovery is resolved. Read preference (missing => true; invalid/future => true with a warning and preserve file until an explicit setting change). Read/validate the previous manifest without first writing a blank checkpoint.

- Previous `running`: show "Recover unsaved work?", checkpoint time, valid document titles/count and any excluded entries. **Restore** restores all valid entries; **Discard recovery** starts a blank. Preference off does not suppress this crash choice. Closing the prompt/window leaves recovery untouched. Do not default an unanswered choice to discard.
- Previous `clean`, preference on: stage/build/restore valid entries automatically and show any repair/exclusion notice. Empty clean session starts a blank.
- Previous `clean`, preference off: start one blank after a retirement commit; previous tabs must not reappear on a subsequent crash.
- No manifest: start a blank. Unreadable/corrupt/future manifest or no recoverable documents: present the failure and explicit **Start new session**, preserving bounded evidence first; never imply successful recovery.

The native startup candidate store holds full validated sessions while the frontend receives only `{token, documents:DocumentSnapshot[], views, activeDocumentId, issues, capturedAtUnixMs, reason}`. It never exposes ProjectCheckpoint bytes/history via recovery IPC. Root constructs/repairs views and builds each score while editing is blocked, then commits `{token, documentIds}` containing exactly the successfully built IDs, in original order. Native checks token, unique subset/membership and startup-only state. Committing restore/discard first writes a new Running epoch/manifest and then installs the workspace with a fresh audio activation. A crash during preview leaves old recovery untouched; a crash after commit sees the restored/fresh state. Retain invalid evidence before clearing candidate state. Always stop/invalidate audio through W05 activation semantics; never restore playing state.

On restore, preserve embedded bytes even if original score/backing paths are absent or changed. Compare each current native save path to its captured saved-file digest. Missing/changed/unreadable native file => detach writable path (None), retain saved comparison/history and notify "Recovered copy requires Save As; its file changed or is missing." Do not rewrite external files or silently mark the copy saved. A matching native file remains its destination. Imported alias is retained only if the existing source still matches embedded base bytes; losing an alias does not lose the embedded origin metadata/protection. Canonical/parent-fallback W05 path identity is applied across restored entries; if two entries claim one writable path or intake alias, detach that conflicting claim from all of them and report it, preserving both scores. Shared immutable source origins alone are valid. Existing cross-document source/destination guards then apply before any Save/export.

Window close differs from Close All: do not remove every document and persist W05's replacement blank before saving the session. Reuse W05's sequential Save/Discard/Cancel decisions, stable revisions and busy/export checks, but call a dedicated native shutdown transaction after every decision succeeds. It validates the complete document list once and builds a Clean envelope from the **pre-close tab order/views**. Saved/unchanged documents retain full sessions; explicitly discarded dirty documents use saved_checkpoint; discard of a never-saved blank omits that document, while an imported score returns to its embedded imported baseline. Active falls back to the next surviving tab then predecessor. If preference is off, Clean envelope has no documents. Commit a new epoch with previous=None, then return success and destroy the window. If failure/cancel, remain open; no clean marker is written. If destroy fails and app continues, block editing until a Running manifest has been re-established, so subsequent crashes cannot look like clean exits. Crash between clean acknowledgement and destruction is intentionally a completed shutdown transaction.

Preference changes use their own atomic file, not edit commands. UI checkbox changes only after native success; failed writes retain prior value and show an error. Turning it off affects clean restart only and does not disable periodic crash backup. Successful explicit Save is not a recovery-retirement boundary: latest native saved comparison/path is included in the next backup, and status honestly reports the backup interval.

## Exact APIs and frontend surface

New `src/workspace/recovery-types.ts` carries `SessionPreferences`, `RecoveryIssue{documentId:string|null,message:string}`, `RecoveryStatus{state:'idle'|'pending'|'writing'|'ready'|'failed',capturedAtUnixMs:number|null,generation:number|null,error:string|null}`, `RecoveryPreview{token:string,reason:'crash'|'clean'|'unavailable',documents:DocumentSnapshot[],views:Record<DocumentId,DocumentViewState>,activeDocumentId:DocumentId|null,issues:RecoveryIssue[],capturedAtUnixMs:number|null}`, and `SessionStartup{preferences:SessionPreferences,preview:RecoveryPreview|null}`. A null preview denotes first run; native resolve still commits the initial Running state. These DTOs contain no recovery Project.

| IPC | Request | Response |
|---|---|---|
| `session_startup` | `{}` | `SessionStartup` (idempotent until resolution) |
| `session_resolve` | `{token:string|null,documentIds:DocumentId[]}` | `{workspace:WorkspaceSnapshot,views:Record<DocumentId,DocumentViewState>,issues:RecoveryIssue[]}`; empty IDs is explicit new/discard |
| `workspace_set_view` | `{documentId,view:DocumentViewState}` | `void`; rejects unknown/closed IDs and startup/shutdown transition |
| `session_preferences_set` | `{restorePreviousSession:boolean}` | `SessionPreferences` |
| `recovery_status` | `{}` | `RecoveryStatus` |
| `recovery_retry` | `{}` | `RecoveryStatus`; native capture only, no frontend music payload |
| `session_shutdown` | `{documents:CloseDocument[]}` | `void` after durable clean commit; requires exactly all live IDs/revisions |
| `session_resume` | `{}` | `void`; used only when window destruction fails after shutdown acknowledgement |

Native emits `recovery-status` with RecoveryStatus; status and recorded timestamps are observers, never write authority. `nativeSessionBridge` maps these methods as `startup`, `resolve(token,documentIds)`, `setView(documentId,view)`, `setPreferences(boolean)`, `status`, `retry`, `shutdown(documents)`, `resume`. W05's `nativeWorkspaceBridge.closeDocuments` keeps its wire shape but root inserts the retirement barrier around native close. No second general-purpose workspace API or scheduler is introduced.

`WorkspaceController` mirrors its existing per-tab view to native through a serialized, coalescing view-send tail (one pending view per live ID); flush that tail before switching/closing/shutdown. Failed sends keep the local view and show recovery status; retry latest view before checkpoint retry. On startup seed existing controllers/views from resolved native records. Add `flushViews():Promise<void>` and `setSessionBridge(nativeSessionBridge)`; keep music authority in bound DocumentControllers. `requestWindowClose` uses shutdown, not closeDocuments; normal Close All retains its W05 behavior. Native validates finite zoom25–300 or resets100, coordinates as safe nonnegative integers, string/note indices, and track-view shape; frontend `repairDocumentView` then repairs against the built score. View failures never alter music history.

Add a small startup `RecoveryPrompt` and one File-menu **Restore previous session** checkbox plus recovery status/Retry text near existing document status. No settings screen redesign. Restore/error prompt blocks document actions; readable titles, explicit choice labels and keyboard focus follow incumbent dialogs. Show no full source paths in generic recovery logs. Pending/writing/ready/failed text must never imply that the ordinary project file was saved.

## Verification and self-review

Prove lossless full-history round trips with saved-vector divergence, undo/redo, redo-only backing and exact immutable source bytes. Prove normal disk saves still omit redo and retain identical schema shape. Test strict future/corrupt/collision cases, two-process ownership, both publication crash windows, partial valid recovery, old-epoch rejection and canceled close without retirement. Deterministic writer latches, not sleeps, establish ordering and one-job coalescing. Measure real large-asset capture/write cost separately from callback/audio tests.

Actual W10 acceptance must force-terminate the diagnostic TabPlayer process after an acknowledged checkpoint, bypassing its close handler, then restore in a fresh process using the same isolated data directory. Use authored untitled/imported documents, distinct notes, redo-only backing, independent views/order, source hashes and real native history. Exercise normal clean shutdown with preference on/off and explicit discard separately. The shared desktop harness creates a fresh native session directory for each ordinary launch and allows an explicit directory for intentional crash/restart tests; repeated file-reopen smoke launches therefore do not inherit recovery prompts. Existing selection/playback gesture harness now also requires W05 document/activation addressing; migrate `tests/desktop/selection-playback-gestures.mjs` as well as the already-listed W05 scripts, without adding an active-origin fallback. Original GP8 is never executed. Physical device or OS claims require separate observed evidence; process-crash tests are not power-loss or cross-platform physical proof.

Self-review: native history/bytes are sole recovery truth; full saved comparison and redo survive; clean shutdown and crash choices differ; manifest references/epochs prevent acknowledged discarded work resurrecting; streaming/capture ownership and limits are explicit; preferences and location do not edit scores; source collisions detach destinations without overwriting; no new implicit-active audio path or broad refactor is proposed. All requirements map to the companion plan's eight tasks. Root owns shared integration and verification, with fresh artifact/code review required before implementation/acceptance.

## Reviewed implementation clarifications — 2026-10-15

The later user-supplied workstation collage supersedes the earlier slate/cream/lime layout instruction. Recovery uses the new compact charcoal/blue styling; functional lifecycle and focus contracts remain unchanged. The user's subsequent instruction requires a generated UI reference for views absent from that collage. Recovery/export concept PNGs and their exact built-in imagegen prompts are retained in `docs/design/reference-workstation/`; incidental generated timestamps, icons and claims are not app data or new requirements.

The store's bounded crash-retry protocol refines the earlier disk-count statement: an old authorized current/previous pair, one interrupted orphan and a newly published payload can temporarily coexist (four canonical payloads). Atomic diagnostic promotion can temporarily retain old/staged diagnostic sets. Managed housekeeping must complete before a subsequent write creates another payload or temporary file, preventing repeated failures from accumulating files. The manifest remains the only restore authority; none of these orphans becomes a restore candidate.

For the pinned `atomic-write-file = 0.3.1`, managed temporary names have exactly the form `.<known app target>.<six ASCII alphanumeric characters>`. Cleanup applies only to regular files with that exact grammar in the owned recovery/diagnostic roots. Near matches, directories and symlinks remain untouched. Every occupied canonical checkpoint name reserves its generation, regardless of entry type; cleanup eligibility does not grant overwrite authority. Failed housekeeping after a manifest commit retains the acknowledged generation/time and reports a Ready warning. Further writes remain gated until the debt clears. Actual Windows sharing-denial and interrupted diagnostic-copy tests exercise this protocol; Windows symlink creation itself remains unverified where privilege error1314 prevents the fixture.
