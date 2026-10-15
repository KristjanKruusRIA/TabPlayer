# Guitar Pro 8 document tabs design

Date: 2026-10-15. Architectural delivery for **W05: Multiple open documents and tab management**. Product starting point: `b73ae93`; tracking starting point: `e2ec67b`, branch `feat/gp8-parity`. The standing user instruction authorizes full parity work, all changes and parallel execution without additional approval questions. This document and its plan receive independent root review before implementation; they do not claim implemented behavior.

## Intent and scope

Let a musician keep two or more scores open, edit/undo/save each independently, copy music between them, and close one or all without losing another score. Native Rust remains authoritative for documents, source/backing bytes, history, redo, dirty state and disk writes. The existing React editor, three columns, slate/cream/lime identity and physical instrument artwork remain the visual authority.

The original 258-row catalog marks W05 missing; its acceptance is "Open two dirty scores and switch/close/save independently." W03/W04, immutable inputs and ordinary save/reopen are regression contracts. This batch adds live tabs, per-tab view location and close transactions. W10/W11 timed checkpoints, crash recovery and restart restoration follow separately. Recent/pinned files W07, templates W06, libraries, associations/drop intake, preferences and localization stay outside this batch. No baseline count/status changes are implied.

Assumptions fixed here: one editor window; one active native audio service; any number of documents subject to available memory; no hidden-tab rendering/audio; native project schema **2**, alphaTab **1.8.4**, Rust **1.88**; existing dependencies only. A tab is a live native session, not a second serialized frontend history. Ordinary save continues to omit unapplied redo; live tabs retain complete redo and its backing assets.

## Approaches and choice

1. **Chosen: native workspace of isolated ProjectSessions, one active editor/audio owner.** Reuses the transactional controller/engine and file format. Requires explicit document addressing through native commands and an activation fence for audio, but keeps memory ownership and source protection understandable.
2. Frontend tabs backed by compact saved snapshots. Smaller first UI change, but `stored_project()` deliberately removes redo and redo-only backing, and two current controllers still address the same native session. Reject: it cannot meet independent history and source guarantees.
3. One native window/audio engine per document. Natural separation, but multiplies device/output/export/shutdown ownership and changes the approved one-window layout. Reject for this delivery.

The work separates into staged contracts, native workspace, frontend coordination, presentational tabs, and root integration of audio/export/editor lifecycle. Root owns shared integration files; disjoint modules can be implemented in parallel after contracts are staged.

## Document identity and live state

New transient types live in `src/workspace/types.ts` and `src-tauri/src/workspace.rs` (camelCase wire fields, strict Rust deserialization for request structs):

```ts
type DocumentId = string;
interface DocumentRevision { documentId:DocumentId; revision:number }
interface DocumentSnapshot extends DocumentRevision { snapshot:ProjectSnapshot }
interface AudioOwner { documentId:DocumentId; activationId:string }
interface WorkspaceSnapshot { documents:DocumentSnapshot[]; active:AudioOwner }
type DocumentIntake = {kind:'candidate';candidate:DocumentCandidate}
  | {kind:'existing';documentId:DocumentId};
interface CloseDocument extends DocumentRevision { discard:boolean }
interface DocumentViewState {
  target:BeatTarget; selectedString:number; selectedNoteIndex:number|null;
  zoom:number; trackView:TrackView; instrumentVisible:boolean;
}
```

Document IDs and activation IDs are native-generated opaque strings using the existing process-ID + monotonic-sequence pattern, in distinct `document-` / `activation-` namespaces. They are identities, not secrets. Unknown/closed IDs reject; there is no "use active document" fallback. A document ID survives tab switches; every actual activation change gets a fresh activation ID, including A→B→A. Selecting the already active tab is a no-op and retains its activation ID.

`DocumentWorkspace` owns an ordered list/map of entries. Each entry owns its original `ProjectSession`, revision and a candidate store for that document's staged assets. It also records an imported intake path, if any, separately from its current native save path. One workspace-level store stages new/open document candidates. `ProjectSession`'s complete native project, cursor, saved command vector and retained assets stay live without compaction or reconstruction during switching. No project-envelope, EditCommand, GPIF or alphaTab model-JSON persistence change is made.

Revisions start at 0 and increase after successful edit, undo, redo and save/save-as. Rejected/canceled operations, export, view changes, staging/canceling candidates and tab activation do not increment them. Wire revisions are nonnegative safe integers, at most `Number.MAX_SAFE_INTEGER`; reject overflow before mutation. The native revision checked by a mutation must equal the caller's revision before any state change/write. Responses carry the matching document ID and new revision. This also prevents a save picker, late edit or Close All decision from applying to a newer document state.

Startup creates one clean blank document. New/Open **add and activate** a tab; they never replace or silently discard the existing blank. They do not ask to save other documents. Before publishing an intake candidate, the frontend builds its applied score successfully, then native code commits only that candidate to a new session. Bad input, build rejection or canceled picker leaves every existing tab, active owner and audio unchanged. Candidate cancellation removes only the requested token. The old implicit-global `replace_project` command is retired from the IPC surface.

## Exact native and bridge boundary

`WorkspaceSnapshot.documents` is in tab order. Workspace snapshots occur at startup and successful add/activate/close transitions; ordinary mutations return only the addressed `DocumentSnapshot`. Cached frontend controllers receive those responses; switching does not reread disk or create a second history.

| IPC command | Exact caller arguments beyond injected native state | Result |
|---|---|---|
| `workspace_snapshot` | `{}` | `WorkspaceSnapshot` |
| `project_snapshot` | `{documentId}` | `DocumentSnapshot` |
| `read_document` | `{}` | `DocumentIntake \| null` |
| `new_document` | `{}` | `DocumentCandidate` |
| `cancel_document` | `{token}` | `boolean` |
| `workspace_add` | `{token}` | `WorkspaceSnapshot` |
| `workspace_activate` | `{documentId}` | `WorkspaceSnapshot` |
| `workspace_close` | `{documents:CloseDocument[]}` | `WorkspaceSnapshot` |
| `apply_edit` | `{document:DocumentRevision,command,assetToken?:string}` | `DocumentSnapshot` |
| `undo_edit`, `redo_edit` | `{document:DocumentRevision}` | `DocumentSnapshot` |
| `save_project` | `{document:DocumentRevision,saveAs:boolean}` | `DocumentSnapshot \| null` |
| `cancel_asset` | `{documentId,token}` | `boolean` |
| `stage_backing` | `{documentId}` | `BackingCandidate \| null` |
| `stage_embedded_backing` | `{documentId,bytes:number[]}` | `BackingCandidate` |
| `export_gp`, `export_midi` | `{document:DocumentRevision,bytes:number[]}` | existing boolean result |
| `export_pdf` | `{document:DocumentRevision,pages,print:boolean}` | existing job-ID/null result |
| `export_audio` | `{document:DocumentRevision,...existingAudioExportPayload}` | existing job-ID/null result |
| `export_status`, `cancel_export` | `{documentId,id}` | existing result |
| `audio_prepare` | `{owner:AudioOwner,...existingPrepareArguments}` | existing result |
| `audio_set_mix` | `{owner:AudioOwner,settings,generation}` | existing result |
| `audio_command` | `{owner:AudioOwner,command:TransportCommand}` | existing result |

`audio_devices`, `audio_status` and the existing `native-audio-status` event remain global read-only interfaces with their current payloads. Harmony-library commands remain application-scoped. No TransportCommand, callback timing, plan schema or status protocol change is needed for tabs. All production audio mutation wrappers require an owner, including `invalidate` and `selectDevice`.

Produce these exact frontend entry points:

```ts
createDocumentBridge(documentId:DocumentId):NativeBridge
createDocumentAudioBridge(owner:AudioOwner):NativeAudioBridge
createDocumentExportBridge(documentId:DocumentId):ExportNativeBridge
nativeWorkspaceBridge:NativeWorkspaceBridge
```

`NativeWorkspaceBridge` has `snapshot`, `readDocument`, `createBlankDocument`, `cancelDocument`, `addDocument`, `activateDocument`, `closeDocuments`, with arguments/results exactly matching the table. `NativeBridge` has readonly `documentId`; `snapshot():Promise<DocumentSnapshot>`; `applyEdit(command,revision,assetToken?)`; `undo(revision)`; `redo(revision)`; `saveProject(saveAs,revision)`; `exportGp(bytes,revision)`; `cancelAsset(token)`; `askUnsaved(title,path)`; and `confirmExport()`, retaining existing result types. It no longer contains document intake/replacement methods.

`NativeAudioBridge` keeps its current method signatures, bound to the captured `AudioOwner`; staging uses its stable document ID. Its ordered command queue belongs to that bound bridge, so an old tab's queue cannot delay a new tab; invalidation still bypasses that queue. `NativePlaybackController.Options.bridge` becomes required, removing the unbound production default. `BackingPanel` receives explicit `stageBacking` and `stageEmbeddedBacking` callbacks; it must not import an unbound native audio singleton.

`ExportNativeBridge` remains bound to one document ID. Its methods become `exportPdf(pages,print,revision)`, `exportMidi(bytes,revision)`, `exportAudio(payload,revision)`, `status(id)`, `cancel(id)`. `useExportCoordinator` requires explicit `native` and `revision` props, freezes the revision along with score/settings/source bytes, and sends it through every export path. Direct GP export goes through the addressed controller. There is no global write-capable bridge that silently resolves the active document.

`DocumentState` gains `documentId` and `revision` beside its unchanged `snapshot:ProjectSnapshot`. `DocumentController.create(bridge,beforeChange?,initial?:DocumentSnapshot,isWorkspaceTransitioning?:()=>boolean)` accepts an initial validated record to avoid a second startup fetch. Existing preview/commit/undo/redo/source handling remains; each bridge call sends its current revision and verifies the returned ID. Intake moves to `WorkspaceController`, so `DocumentController.open/new` are removed, with their replacement/cancellation assertions transferred to workspace tests rather than discarded.

## Open identity, candidate ownership and destination protection

Use canonical existing filesystem paths for duplicate intake detection (including symlink resolution); for a new destination resolve its existing canonical parent plus filename, using platform path comparison. Do not use score title, original content hash or embedded GP filename as tab identity.

- A currently open native save path activates its existing tab. Opening an imported GP/XML intake path again activates that imported tab. Detect both before expensive intake and again at candidate commit. Duplicate activation does not reset or discard its dirty edits.
- Distinct `.tabplayer` paths are separate documents even when they contain the same original GP/source bytes. Two Untitled tabs are separate. An imported entry retains its original intake alias after Save As; a native/blank entry follows its current native save path. A previous native Save As destination becomes available for a separate later Open.
- Asset candidates belong to a stable document ID, not the active tab or activation ID. Commit/cancel with another ID rejects without consuming the candidate. A canceled/failed operation cannot expire other documents' candidates. Closing a document retires its candidates; a late token/ID never falls back to the replacement blank.
- Save/Save As/export protects immutable score and backing origins/identical-source copies across **all open sessions**, including inactive tabs and retained redo assets. Source protection remains effective when original paths have changed externally. Reject a destination owned as another open document's current native path; do not silently overwrite it. Recheck destination ownership and the caller's revision after a native picker returns, before write.
- Native writes keep existing atomic replacement, native schema-1 migration, schema-2 output, engine/hash validation and "mark saved only after success" behavior. Saving A never compacts A's live redo/assets or changes B's saved marker/path/history. Opening a normal saved file still has no redo, as before.

## Frontend transitions and editor operation policy

`WorkspaceController` owns cached addressed controllers, ordered IDs, the active owner, per-document `DocumentViewState`, one `ClipboardStore`, and a small busy/error state. It does not own an alternative score/history. Its API is `create(bridge)`, `getState`, `subscribe`, `newDocument`, `openDocument`, `activate(documentId)`, `close(documentId)`, `closeAll`, `requestWindowClose():Promise<boolean>`, `setView(documentId,view)`, and `beginEditorOperation(documentId):()=>void`.

`DocumentController.hasPendingActions():boolean` accounts for queued work synchronously, before the first promise turn; `whenIdle():Promise<void>` exposes its existing tail. Workspace transitions reject with an actionable message while a document action is pending or an editor-operation lease is held. An accepted transition sets workspace busy synchronously before awaiting anything, preventing new document actions through a constructor-supplied `isWorkspaceTransitioning:()=>boolean` guard. `requestClose` is the only controller operation permitted inside that transition; it calls its existing internal save path. Do not build a general scheduler or plugin framework.

`beginEditorOperation` synchronously reserves the single external-operation slot, checks the originating document is active and no conflicting work is pending, and returns an idempotent release function. Use it for the **complete** backing stage→edit/cancel sequence, modal dialog lifetime, direct GP export dialog/write, and export-dialog generation→native job→terminal result/cancellation. An import that owns the lease may commit its addressed edit; the guard blocks workspace transitions, not its own internal work. App controls disable ordinary document-changing actions during a lease; Pause/Stop remain usable. Window close during an external operation returns false with "Finish or cancel the current operation before closing." It does not destroy the window or pretend cancellation completed.

The export dialog already owns its lease when Export runs; do not acquire a second lease. Any print-layout edit made by that export remains an ordinary addressed controller edit before the hook freezes its revision. Errors keep the dialog available or release its lease when dismissed, as appropriate. Native exports also reject workspace transitions while the single native export slot is running; the frontend lease covers dialogs and browser preparation before a job exists. Native export launch acquires the audio/workspace transition gate after its picker, checks active document/revision, captures origin protection/backing and starts the owned job before releasing it. Direct GP/MIDI writes hold that gate through the bounded write. Cancel releases the slot/lease only after the native terminal state, including when a job ID arrives after the user requested cancellation.

`WorkspaceApp` mounts exactly one `App`, keyed by activation ID. It passes the addressed controller, audio/export bridges, workspace actions/busy state, shared clipboard, saved view and view callback. Unmount retires view handlers/player subscriptions; hidden tabs have controllers but no App/ScoreView/NativePlaybackController. Preserve target, selected string/note, zoom, track display view and instrument toggle per tab. Repair targets/view IDs against the canonical score when restoring them. Musical selection, incomplete drafts, menus and dialogs are transient; they reset on activation. Modal lifetime blocks activation, so A's draft cannot reach B. The application clipboard survives switches and supports copy in A / paste in B with one destination undo transaction.

Initial view is target `{track:0,staff:0,bar:0,voice:0,beat:0}`, selectedString6, selectedNoteIndexnull, zoom100, trackView `{kind:'selected'}`, instrumentVisiblefalse. Repair uses existing canonical target repair, clamps a fretted string to the current tuning (uses1 for a nonfretted staff), clears an unavailable selected note, filters removed custom track IDs and falls back to selected view if none remain. Preserve finite zoom within the incumbent25–300 range; malformed values reset to100. View updates never create a document command, change dirty state or prepare audio.

## Single active audio owner

Add one ordinary `Mutex<()>` access gate in `NativeAudio`. Workspace add/activation/close transitions, export launch/writes, audio preparation/mix and ordinary audio commands acquire it **before** briefly acquiring the workspace lock. Preparation/mix/ordinary commands keep the gate until the existing AudioService operation returns; clone required addressed backing/source data under the workspace lock and release that lock before expensive decode/resource work. Never acquire the locks in the opposite order, and never use this gate in the real-time callback. Run potentially blocking transition/prepare work through existing `spawn_blocking` paths. **Invalidate is the sole exception:** it acquires the workspace lock alone, checks the exact active owner, calls the existing atomics-only `AudioService::command(Invalidate)` while retaining that workspace lock, then releases it. It never acquires the access gate, service control mutex or backing/cache locks. Keep the ordinary Mutex; no RwLock or additional coordination framework is needed.

`audio_prepare`, `audio_set_mix` and every audio command require exact equality with the workspace's current `{documentId,activationId}` before service mutation. Preparation/mix/ordinary commands check under gate→workspace; Invalidate performs its check and atomic service mutation in one workspace-only critical section. Recheck after any asynchronous stage that happened before acquiring the applicable lock. Stale owner errors must occur before `desired_generation.fetch_max`, so an old A invalidation/prepare with a large generation cannot poison B. A→B→A rejects the first A activation even though its stable document ID matches again. Because preparation releases the workspace lock before expensive work, a valid current-owner Invalidate can overtake preparation even while a tab transition is waiting for the access gate; preserve the existing `invalidate_does_not_wait_for_preparation_mutex` behavior.

The activation ID is needed at this boundary because the existing generation counter is frontend-reserved, not native-allocated: A can reserve generation100 while its worker is pending, with native desired10. Before a new preparation reaches native code, a B→A switch could advance native invalidation floors only to11/12. The first A's delayed prepare100 and queued Play100 then pass a document-ID-only check and exceed that floor. An opaque activation check rejects both before they touch the generation atomics. Reusing generations as the activation fence would instead require a shared frontend allocator, reserved activation floors and allocation/teardown coordination across controllers. This design keeps the new field confined to the native ownership wrapper; it is not a second playback clock, command-consumption token or causal status-acknowledgement scheme.

An activation change holds gate→workspace, computes a checked generation greater than the **then-current** published/desired generations, invalidates the old service and publishes the new active owner within that same workspace critical section, before returning the new snapshot. Thus an old-owner Invalidate either runs first and is included in the transition's generation floor, or runs after owner publication and rejects before touching atomics; it cannot pass an owner check and race a huge invalidation after publication. The gate prevents an already-started old prepare/mix from completing after this boundary; a switch may wait for that operation and shows busy, while current-owner invalidation remains available. Clear the native embedded-source/current-backing cache on owner change under the existing gate, outside the workspace-only Invalidate path. The new frontend player initializes its counter from native status as now, then prepares only the new owner. Generation fences, queue/callback validation and callback epochs remain authoritative inside AudioService; no callback document map or multi-client engine is introduced.

Switching/closing an active tab stops it and clears transient transport/range/loop/count/practice state. Reactivating a tab does not resume audio automatically; its authored sound/mix/backing settings remain. The global selected output device remains unchanged. Failed intake/close validation does not invalidate current audio. Accepted transitions need not wait for a device-status event to establish command ownership, but the UI must not claim sample silence before native status/capture establishes it.

## Close one, Close All and window close

`requestClose` shows Save / Discard / Cancel using the current score title and path. Cancel or canceled/failed Save leaves that document live and dirty. Save uses the addressed session/revision. For a single inactive tab, closing it does not switch or disturb active audio. Closing the active tab selects the next tab at its old index, otherwise its predecessor. Closing the last tab or Close All creates one clean blank tab with new identities.

Close All/window close holds the workspace transition reservation and asks dirty documents in tab order. Collect decisions and each post-save revision; do **not** remove a tab or clear its candidates after an early Discard. If a later prompt cancels/fails, keep every tab/history/redo/location; successful explicit earlier saves remain saved. An approved dirty close entry has `discard:true`; clean/successfully saved entries use `discard:false`. Native `workspace_close` rejects empty/duplicate/unknown IDs, revision mismatch, or dirty entries without discard **before removing anything**. It validates the complete list, then commits removal and any active-owner change atomically.

`requestWindowClose` runs the same decision collection and native atomic close, then returns true for the one-window bootstrap to destroy the window. The native workspace creates its ordinary replacement blank, but the bootstrap does not mount/render it before destruction. No document is discarded before every decision succeeds. Prevent reentrant close with the workspace busy reservation. Native app close continues to be intercepted in `main.tsx`; failed/canceled close returns false. A forced process crash has no recovery guarantee in W05; W10 will add it without changing ordinary `.tabplayer` semantics.

## Tab surface

Operate mode: a narrow row immediately below the existing toolbar, above the three-column workspace. Tabs show the score title (Untitled fallback), existing dirty dot and a separate close button. Full path, or "Unsaved score", is available as the accessible description/title. Duplicate titles get distinct accessible labels using position/path; do not rename the score. Add "Close score" / "Close all scores" to the existing file action group; existing New/Open/Save/Save As/history/export controls retain their meaning.

Use a controlled `DocumentTabs` component with `tabs:readonly DocumentTab[]`, `activeId`, `disabled`, `onActivate(id)` and `onClose(id)`; `DocumentTab` is `{id,title,path,dirty}`. Use accessible tablist/tab semantics with a sibling close button per item; no nested interactive elements. The active score container is the corresponding tabpanel. Roving focus Left/Right/Home/End moves focus; Enter/Space activates, preserving the current score until explicit activation. Ctrl/Cmd+W closes active; Ctrl/Cmd+Tab and Shift cycle tabs outside text fields/dialogs. Dirty close always goes through the decision workflow. A close-button click never first activates an inactive tab.

The row scrolls horizontally at 960/1280/1600 widths; active/focused tab stays reachable, long titles truncate with the full label exposed, and Close All remains reachable. Retain existing focus styles and tokens; no new dependency, icon system, decorative illustration, navigation rail or responsive layout redesign. On close, focus the new active tab or the originating file action after a canceled dialog. Report transition errors visibly without changing the active document.

## Acceptance and limits

Tests must prove two dirty documents and duplicate-title/source cases; independent history/saved markers/redo-only backing; candidate owner and stale revision/closed-ID rejection; canceled/failed file operations; staged Close All cancellation; full-process save/reopen and old-file compatibility; and per-tab view/shared clipboard. Bridge fixtures must require explicit document/owner addresses, never restore a no-argument active fallback for older scripts.

Native integration tests must delay an A prepare/mix/command, activate B, then attempt old-A mutations including huge invalidate generation and A→B→A. Assert B's accepted generation/settings/backing remain unchanged. Add a deterministic latched-preparation test: hold preparation/access gate with workspace lock released, queue a transition waiting for the gate, and require valid A Invalidate to acknowledge/update its atomics before preparation is released. After release and a barrier acknowledging new-owner publication, old A's huge Invalidate must reject without changing the transition's accepted generation floor. Preserve the existing service-level nonblocking test. Export tests cover A's backing/protection context and the busy/cancel policy before and after a job ID. Actual Windows acceptance uses original authored scores with distinct literal pitches/backing, source hashes, one isolated diagnostic process and existing output loopback capture; verify no inactive score sounds and switching never autoplays. Inspect the tab row and approved editor once at 960/1280/1600, fix one defect batch, confirm at most once.

Five focused failure classes for independent review: (1) late A asset/save completion after active B; (2) A→B→A old activation with a newer numeric audio generation; (3) Close All Discard A then canceled Save B; (4) an export canceled before its native job ID arrives; (5) Save As to an inactive tab's destination or redo-only backing source.

This establishes the bounded W05 workflow only. No timed autosave, crash/session restore, original GP8 runtime equivalence, physical non-Windows audio, signing/installation or complete parity claim follows from these tests. Future recovery must serialize full native histories/cursors/saved comparison/assets in its own application envelope; compact ordinary saves and metadata-only frontend snapshots remain unsuitable for that purpose.

## Design self-review

The chosen design has one stable document address, one activation fence and one native history per tab. Intake, asset ownership, all write IPCs, audio mutations, export jobs and close decisions have explicit origins. Normal saves retain their prior schema/redo semantics; live switching preserves full sessions. Busy rules cover pre-job/dialog/staging intervals; Close All does not partially discard on cancellation. Root integration and disjoint worker ownership are assigned by the accompanying plan. There are no deferred choices inside W05; W10/W11 and adjacent catalog families are deliberately separate deliveries.
