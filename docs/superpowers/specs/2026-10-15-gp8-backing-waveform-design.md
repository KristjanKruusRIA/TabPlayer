# GP8 backing waveform and visual synchronization

Date: 2026-10-15. Status: proposed written design for root review; no implementation or acceptance is claimed. The standing user instruction authorizes completing deferred parity work without more approval questions, using parallel workers and independent review. This architectural slice introduces one read-only IPC; the root reviews and freezes this spec and its implementation plan before dispatch.

## Outcome and scope

P15 gains a real backing waveform, source-time ruler, performed bar/beat grid, zoom/pan, score-selection matching and reversible visual sync-point editing. Preserve the Rust/Tauri native audio clock, existing backing import/assets, numeric anchors, mix, immutable source/history and document ownership. The approved umbrella is [GP8 feature parity](2026-10-15-gp8-feature-parity-design.md); the baseline P15 row is [parity baseline](../../validation/2026-10-15-gp8-parity-baseline.md#backing-audio-and-practice).

The retained official backing-track page and PDF printed204–214 describe waveform/grid/zoom and beat sync points. Existing TabPlayer anchors warp backing against authored score time. GP8 tempo extraction/conversion and entry/exit brackets are separately tracked by P16 and remain open. This slice adds no tempo generation, pitch/filter/EQ controls, codecs, waveform trimming, recording, transport action or waveform-to-score selection/seek. Score-to-waveform matching is sufficient for P15. Viewing, zooming and selecting a marker do not edit music or start playback.

## Selected architecture and reference

Use one native waveform query over cheap encoded-source captures, dependency-free native peak reduction, pure TypeScript timeline projection and an existing-dock Backing view. This gives output-device-independent viewing without altering accepted audio paths. A browser audio decoder would duplicate codec behavior. Reusing prepared playback PCM would require new exact source identity through prepare/setMix/device paths; omit that optimization. Add no dependency or global asset/job/cache framework. `AudioService`, device and renderer remain unchanged.

The user requested actual GenAI images before new views. Root generated and inspected backing-waveform-concept.png (removed before publication), SHA-256 `D19D16955B14E9DCB6A1958D35F70E4CFF6C8FFCB11900CDA189954674E6D576`; provenance (removed before publication), SHA-256 `67E9B9E86BBA9F1D875353398B9DDE79AF554ACD0C6E0B109529E7198E2F24EC`, retains the exact prompt and adoption notes. Adopt the Backing dock tab, compact filename/zoom toolbar, violet waveform, seconds ruler, real measure/occurrence grid, distinct handles/cursor and compact selected-point readout. Preserve current adaptive dock height, dock ending before Inspector, existing numeric controls and gain units. Generated measure/time inconsistencies are illustrative errors: runtime relationships come exclusively from actual peaks, tempo, performed occurrences and backing map. No toolbar/Inspector redesign is included.

## Exact read contract

Add `src/audio/backing-waveform-types.ts`; Rust equivalents live in new `src-tauri/src/backing_waveform.rs`, use strict camelCase serde and deny unknown input fields. Required fields are never silently defaulted. Existing AudioOwner enforces nonempty identities and DocumentRevision enforces a safe revision; callable validation additionally requires document.documentId to match the nonempty owner.documentId.

```ts
type WaveformSourceIdentity=
  |{kind:'asset';assetId:string}
  |{kind:'embedded';sourceKey:string;sha256:string};
type WaveformSourceInput=
  |{kind:'asset';assetId:string}
  |{kind:'embedded';sourceKey:string;sha256:string;bytesBase64:string};
interface BackingWaveformRequest {
  owner:AudioOwner;document:DocumentRevision;source:WaveformSourceInput;buckets:number;
}
interface WaveformPeak {min:[number,number];max:[number,number]}
interface WaveformPeaks {
  durationMs:number;sampleRate:number;frameCount:number;channels:1|2;
  bucketCount:number;peaks:WaveformPeak[];
}
interface BackingWaveform extends WaveformPeaks {
  owner:AudioOwner;document:DocumentRevision;source:WaveformSourceIdentity;
}
interface NativeBackingWaveformBridge {
  readonly owner:Readonly<AudioOwner>;
  read(document:DocumentRevision,source:WaveformSourceInput,buckets:number):Promise<BackingWaveform>;
}
```

`createDocumentBackingWaveformBridge(owner:AudioOwner)` in `src/audio/backing-waveform-bridge.ts` copies/freezes the owner, exposes that same immutable value as bridge.owner, and freezes the returned bridge. It invokes exactly `backing_waveform {request:{owner,document,source,buckets}}` using the captured owner. The single request DTO makes strict serde validation apply to the whole logical request and nested source/owner/document; it does not claim strictness for the outer Tauri argument wrapper. No custom raw-body/CommandArg framework is introduced. It validates the returned owner/document/source against that captured request before resolving. This bridge is separate from `NativeAudioBridge`; it grants no history/asset mutation, staging, arbitrary file read or audio command. WorkspaceApp creates it once per activation and passes required `waveformBridge` to its keyed App. No events, candidate tokens or file paths enter this query.

`buckets` is an integer1–8192 inclusive; the UI requests8192. Digests/sourceKey are64 lowercase hexadecimal characters. The new query-only encoded-audio-container ceiling is `MAX_WAVEFORM_AUDIO_BYTES=512*1024*1024` raw container bytes after base64 decoding, not512MiB of base64 text and not decoded PCM. Before decoding, require base64 text length no larger than `4*ceil(MAX_WAVEFORM_AUDIO_BYTES/3)` and padding-derived binary length no larger than MAX_WAVEFORM_AUDIO_BYTES; after decoding require actual bytes.len() within the same bound. The standard padded base64 decoder remains authoritative for malformed text. This reuses the numeric512MiB project/checkpoint ceiling but is a **new waveform-query limit**. Existing direct backing import/StoredAsset validation has no universal audio size cap; it is not retroactively changed. A larger existing asset remains playable/editable but waveform reading reports the explicit limit. IPC has already materialized its input string before this check; do not claim streaming admission.

`makeEmbeddedWaveformSource(sourceKey:string,bytes:Uint8Array):Promise<Extract<WaveformSourceInput,{kind:'embedded'}>>` validates a64-character hexadecimal base digest, normalizes valid mixed-case input to lowercase for the wire sourceKey, then computes SHA-256 and base64 once per immutable embedded-byte/source identity using existing platform APIs, with the same raw container-byte ceiling. Uppercase digest/sourceKey values supplied directly on the wire remain invalid. The UI never rehashes/re-encodes during clock updates. No private song or bank is added to fixtures.

## Source admission and work ownership

Add narrow `ProjectSession::capture_asset(&self,asset_id:&str)->Result<StoredAsset,ProjectError>` and `current_backing_asset(&self)->Option<Option<&str>>`. The latter examines baseline plus applied user commands only: absent setBacking returns None, explicit score-only returns Some(None), and a backing edit returns Some(Some(id)). Do not include redo-only commands or clone the whole checkpoint. `StoredAsset` already shares encoded bytes through `Arc<str>`.

`DocumentWorkspace::capture_waveform_source(&self,owner:&AudioOwner,document:&DocumentRevision,source:&WaveformSourceIdentity)->Result<WaveformSourceCapture,String>` checks admission/not frozen, exact active owner, matching owner/document ID and exact safe document revision. For asset input require the current applied backing asset to equal assetId and clone that committed StoredAsset. A historical/saved-only/redo-only asset is not current. For original embedded input require no applied setBacking override, a file base, and sourceKey matching native `imported_digest()` case-insensitively; returned identities remain lowercase. Blank bases and explicit score-only reject embedded input.

`WaveformSourceCapture` is an internal enum `Asset(StoredAsset)|Embedded`; it is not serialized. The supplied embedded bytes are already extracted by the existing frontend build. Native verifies current document/base binding and independently hashes supplied audio against sha256. It does not independently prove those bytes were extracted from that GP archive; extraction provenance is established by existing extraction and new integration fixtures. This query cannot attach or change those bytes.

`BackingWaveformService {work:Mutex<()>}` is one application-scoped service. Its exact callable seam is `read(&self,workspace:&Mutex<DocumentWorkspace>,request:BackingWaveformRequest)->Result<BackingWaveform,String>`. The Tauri command `backing_waveform(request:BackingWaveformRequest,app:AppHandle)->Result<BackingWaveform,String>` calls this on its blocking runtime. Register the same command and state in production and desktop-test builds.

The service validates shape/bucket limits, acquires its sole waveform work gate, then captures/rechecks source under the short workspace lock. Release workspace lock before base64 decoding and SHA validation; recheck owner/revision/source after that work and immediately before full audio decode. Decode with existing `decode_audio`, reduce to peaks, then recheck owner/revision/source before returning the receipt. Hold only the waveform gate during expensive work, never the audio access/control or workspace locks. This serializes decodes and prevents normal concurrent waveform work without a generic job system. Waiting obsolete queries fail their admission recheck before decoding.

The existing decoder materializes full stereo PCM; the encoded ceiling and output bucket bound do **not** cap its decoded heap, make it streaming, or interrupt an in-progress decode. Active decode may finish after source retirement, then its result is rejected and captures released. There is no new persistent native waveform cache, PCM reuse, cancellation registry or modification to audio prepare/setMix/device/renderer. Query failure never mutates workspace/project/history/assets or stops playback.

## Peak reduction

`src-tauri/src/audio/waveform.rs` exports `reduce_waveform(audio:&DecodedAudio,buckets:usize)->Result<WaveformPeaks,String>` and the plain peak/result types reexported by the root DTO module. Validate nonempty finite PCM, valid positive sample rate/original channels1–2 and safe serialized frame count. Let `n=frames.len()` and `k=min(buckets,n)`; bucket i covers `[floor(i*n/k),floor((i+1)*n/k))`, with overflow-safe index arithmetic. Return exact per-channel minima/maxima for every frame in each bucket; mono's internally duplicated channels remain duplicated in the result, while the UI draws one lane. Duration is `1000*n/sampleRate`.

Do not average stereo channels or sample one representative frame: both lose real peaks/opposite-phase content. Return exactly k ordered peaks, bucketCount=k, no PCM or filenames. The frontend draws only these values; no placeholder waveform. Cache one completed source identity plus8192-bucket data in the mounted active view, reuse across anchor/offset/mix edits, and discard on source/activation change or unmount. No unbounded map of sources is needed.

## Timeline and score matching

Add pure `src/audio/backing-timeline.ts`, consuming these read-only types in the shared TS types file:

```ts
interface BackingTimeline {
  generation:number;durationTick:number;
  tempos:readonly PlanTempo[];occurrences:readonly MeasureOccurrence[];
}
interface BackingScorePoint {tick:number;anchor:Pick<SyncAnchor,'bar'|'occurrence'|'ratio'>|null}
interface BackingScoreSelection {points:readonly BackingScorePoint[];spans:readonly PlaybackSpan[]}
interface BackingGridLine {
  key:string;bar:number;occurrence:number;ratio:number;tick:number;audioMs:number;kind:'bar'|'beat';
}
```

`NativePlaybackController.backingTimeline():BackingTimeline|null` exposes only the current generated plan's timing, with stable timing-array references. `backingScoreSelection(target:BeatTarget,selection:MusicSelection|null):BackingScoreSelection` resolves current target performed rows and uses existing `selectionPlaybackChoices` for range spans. These reads require a successfully generated current plan, not an output device/ready status; during preparation/after destruction return null or empty respectively. They introduce no transport action. An unrepresentable grace lead-in remains a visible point with anchor:null; do not fabricate an in-bar synchronization ratio.

The controller explicitly notifies subscribers after its preparation guard is released and current generated timing becomes readable, including an output-device failure before any matching-generation native status. Getter availability alone or a future device status must not be required to wake the view.

Pure interfaces are `scoreTimeToAudioMs(timeline,backing,scoreTimeMs):number`, `scoreTickToAudioMs(timeline,backing,tick):number`, `projectBackingGrid(timeline,backing,startMs,endMs):BackingGridLine[]`, `projectBackingSelection(timeline,backing,selection):{points:number[];spans:{startMs:number;endMs:number}[]}`, and `moveBackingAnchor(backing,index,sourceMs,timeline,durationMs):BackingSettings`. Here timeline is BackingTimeline, backing is `Pick<BackingSettings,'offsetMs'|'anchors'>` for projections and full BackingSettings for move, selection is BackingScoreSelection, and all index/time/window arguments are numbers. sourceMs is the visible source coordinate; the stored anchor.audioMs is sourceMs+offsetMs. Functions preserve inputs; move returns a detached setting and validates the whole candidate with the same order/map rules. The time variant places the existing nominal native scoreTimeMs playhead without inventing another tick clock.

Use full tempo segments to convert tick to nominal score milliseconds, including tempo changes within a bar. Resolve anchor ticks from actual `(bar,occurrence,ratio)`, then use the exact Rust BackingMap semantics: zero anchors unit slope, one translation, two+ piecewise linear with endpoint extrapolation; final sourceMs=`interpolatedMs-offsetMs`. Therefore moving a visible handle to sourceMs writes anchor.audioMs=`sourceMs+offsetMs`. Require source position0–durationMs and nonnegative stored audioMs; an offset can make part of that interval unavailable. Preserve strict increasing score/audio positions, reject duplicate seams/crossed neighbors/missing occurrences without changing any other anchor. Do not sort/reassign written identities.

Grid lines use occurrence.startTick and actual denominator clickTicks, with the same step fallback only when clickTicks is absent. Labels show written measure+1 and occurrence+1; pickups/free-time tails and skipped endings follow performed bounds. Filter to the visible source window before rendering. Selection mirrors every valid performed copy/span with readable occurrence labels; it must not silently treat a repeated written bar as its first occurrence. Selecting a real grid beat supplies an unambiguous anchor tuple for Add sync point. Source-only clicks do not change score selection. Use existing map to place native nominal score-time playhead, distinct from edit selection; suppress it during count-in/not-ready/error. Peaks/grid do not rebuild every33ms.

## View, query lifecycle and editing

Add `BackingWaveform.tsx`, `backing-waveform.css` and `useBackingWaveform.ts` under src/audio. The hook accepts `{bridge,document,source,enabled}` where document is DocumentRevision and source is WaveformSourceInput|null; it returns `{kind:'none'|'loading'|'ready'|'error',data:BackingWaveform|null,error:string|null,retry:()=>void}`. Only one request is in flight per mounted hook; revision/source changes coalesce to the latest desired request after it settles. Use bridge.owner as the explicit expected document/activation identity and part of the request-generation key; the hook independently rejects a response whose owner, document or source differs from the captured request/current bridge. Ignore obsolete success/error, and synchronously hide data whose source no longer matches. Reuse completed peak data across revisions when the same source remains current, while projection always uses current settings/timeline. Retry reads current identity. Hidden dock defers starting a read; it does not expose previous-source data.

`BackingWaveformProps` is pinned in the TS types file: `{document:DocumentRevision;source:WaveformSourceInput|null;filename:string;bridge:NativeBackingWaveformBridge;timeline:BackingTimeline|null;selection:BackingScoreSelection;settings:BackingSettings|null;effectiveBacking:Pick<BackingSettings,'offsetMs'|'anchors'>|null;scoreTimeMs:number|null;enabled:boolean;busy:boolean;beginOperation:()=>()=>void;isCurrent:(document:DocumentRevision,settings:BackingSettings)=>boolean;onEdit:(command:Extract<EditCommand,{type:'setBacking'}>)=>Promise<void>}`. settings is null for original embedded/read-only and score-only; effectiveBacking permits factual original embedded mapping without staging. Parent supplies scoreTimeMs only for valid native playing/paused state. `isCurrent` compares document revision and exact current asset/offset/anchors/mix synchronously from the controller, not a stale rendered closure.

The toolbar shows basename, Zoom out, current percentage, Zoom in and Fit. Zoom factors are1/2/4/8/16;100% is fit, with fit recomputed to actual viewport width. Internal horizontal scroll provides pan. Keep marker hit targets and focused labels readable without expanding existing default dock height; local content scrolling is permitted. Numeric inspector remains the precision editor. Ready original embedded audio is viewable before Edit embedded backing, with truthful read-only cue and existing conversion action in BackingPanel. Empty, loading, Preparing score timing, error/Retry and ready are factual states; no invented progress or peaks. Score-only never queries an old asset.

Anchor selection is transient and has no edit. Add sync point uses the selected real grid beat and its currently mapped source position, only for explicit editable backing. Delete removes the selected existing index. Both preserve all unrelated settings and use existing setBacking. Original embedded uses existing explicit conversion before these actions. Nonfinite/order errors remain visible with unchanged history.

For dragging an existing handle, capture document revision, source identity, full settings/map, selected index and pointer geometry on pointer-down; acquire beginOperation and hold it through commit. Pointer motion updates a local preview only. Do not treat the lease's own busy render as an external invalidation. Release commits exactly one setBacking if changed and `isCurrent` still matches; rejection restores committed display and surfaces the error. No-op, Escape, pointercancel, lost pointer capture, unmount or stale identity cancels with zero edit and releases exactly once. Disable competing map/zoom/add/delete actions during the gesture. Use pointer capture and keep drag events from the score/global note-entry shortcuts.

Keyboard equivalent: focused handles expose slider semantics, source-ms aria values and measure/occurrence labels. ArrowLeft/Right preview−/+1ms, Shift arrows−/+10ms; commit once on corresponding key-up, Escape cancels, and blur cancels. Home/End and other keys do not mutate a handle. Numeric controls remain available. Keyboard transaction uses the same lease/current/cancel path, and handled keys stop propagation.

## Ownership and verification

Root freezes shared DTOs/fixtures first. Parallel workers then own native pure peaks, pure TS projection, and isolated hook/component/CSS/tests; root alone owns source-capture/runtime/registration, controller timing reads, WorkspaceApp/App dock/lease joins and actual runtime. No worker edits Library/recovery/session/Store or audio device/renderer. The detailed [implementation plan](../plans/2026-10-15-gp8-backing-waveform.md) records exact paths and gates.

Verification includes shared strict request fixtures, true impulse/opposite-phase peak oracles, shared Rust BackingMap/TS timeline fixtures (offset sign, intra-bar tempo, repeats/seams), owner/revision/source delayed-work rejection, output-device-free native query, UI drag/keyboard one-edit/cancel/lease lifetimes, cache/no33ms-reissue, and actual authored desktop import→view→zoom/pan→repeated-beat anchor edits→Undo/Redo→save→fresh reopen. Inspect960/1280/1600 against the actual generated concept. Preserve exact source bytes, project/redo on view-only actions and actual asset bytes after edits. Do not rerun old physical audio or Long captures merely to verify visualization. Actual OS/platform/shipping gaps stay explicit; P15 advances only after its own source and desktop proof, and P16 remains separate.
