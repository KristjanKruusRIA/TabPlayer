# GP8 reference synchronization, brackets and tempo conversion design

2026-10-15. Extend the accepted P15 Backing view in the authoritative `feat/gp8-parity` worktree. Standing human authorization covers implementation in this chat, parallel workers and independent review without another approval gate. This specification closes a bounded P16 implementation slice; it does not declare full GP8 parity or verified proprietary bracket interchange.

## Outcome and evidence

A user can choose **Score follows audio**, align nondestructive entry/exit brackets and occurrence-aware interior points, hear reference audio advance linearly at 100%, see derived segment tempos, and explicitly convert between authored score tempos and sync points. All changed actions are one undo step and survive native save/reopen. **Audio follows score** remains the default for old projects and restores the authored clock.

The [official backing-track manual](https://www.guitar-pro.com/docs/gp8/audio/backing-track), checked 2026-10-15, establishes bracketed playback, zone growth when adding bars, linear unfolded audio, sync timing overriding score automations, and explicit replace/add score-to-sync plus sync-to-score conversion. It does not settle exact grace, EOF-conflict, collision or interchange encoding behavior. Policies below are our explicit implementation decisions. No proprietary executable or installer is run.

Actual generated reference: `backing-tempo-concept.png` (removed before publication), SHA256 `8F3F6B33FA1C6099168DE4D84E428AA0203A49C2B3B00883E0F4084725F25666`; prompt/provenance `backing-tempo-generated-concept.json`, SHA256 `DEB694E67ACC5C91527028BDF4C4ED28CBE1F71F0D2F0C87E6EC114298532FF3`. Root inspected the generated pixels before product work. Inherit the accepted charcoal/cream/blue Operate surface, sidebar Sync timing disclosure and existing dock. Preserve adaptive dock heights ending before Inspector, numeric anchors and gain units. The generated geometry, note/time labels and blended stereo depiction are illustrative; real peaks stay separate mono/stereo lanes.

Source investigations: `.analysis/parity/backing-tempo-preflight.md` `7C483BC0`, clock contract `DD57D731`, conversion contract `548D24CF`, view contract `1499CA61`. They are design evidence, not executed acceptance.

## Chosen approach and limits

Use one effective native playback plan derived from the authored plan and current sync settings. Preserve the authored model and a transient authored timeline for notation-view time conversion. This keeps one native clock, source bytes and the existing DSP. Writing tempos during every drag would discard authored work; adding another media player would duplicate transport authority. Neither is required.

No new dependency, decoder, audio service, global job/cache framework, generic command batch, schema-version bump, destructive audio trim, recording, pitch/filter work or unrelated shell redesign. Native history stores original source/commands/assets; frontend replay derives musical settings, as today. Source/Windows/all-platform/shipping and GP interchange claims stay separate. P15 accepted visuals/audio/Long/Library/OLE are retained without freshness reruns.

## Exact settings and score-command wire

Add `ReferenceSyncBounds {entryAudioMs:number; exitAudioMs:number}` and `referenceSync?:ReferenceSyncBounds|null` to `BackingSettings`. Rust mirrors this with strict camelCase fields and defaulted `Option<ReferenceSyncBounds>`, omitting None on serialization. Missing/null mean legacy **Audio follows score**; a non-null object means **Score follows audio**. Normalize omitted/null for semantic comparison; do not migrate old histories eagerly.

Stored bracket coordinates use the existing anchor convention: **physical source ms = stored audio ms − offsetMs**. UI writes source plus offset once. Offset-only changes leave stored pins fixed and translate all visible source positions by the negative offset delta without changing interval BPM. Reference mode permits finite negative stored coordinates only when physical source coordinates satisfy the active bounds; legacy anchors retain their current nonnegative stored rule. At offset−120, source0/1000/2000 stores−120/880/1880.

New score command:
```ts
interface RatioTempoPoint {bar:number;ratio:number;bpm:number;linear:boolean}
{type:'replaceTempoAutomations';points:RatioTempoPoint[]}
```
Define its shared TS types in `src/editor/tempo-types.ts`; mirror strict Rust struct/variant. This is a score edit, excluded from `SettingsEdit`. Require exact fields, u32 bar, finite ratio0..1, finite positive quarter BPM, boolean linear, strict lexicographic bar/ratio order, no duplicate, nonempty list starting bar0/ratio0. Replay additionally requires addressed bars to exist. The generic command accepts ratio1 because public GP supports it; generated conversion owns receiving seams at ratio0 and emits no terminal outgoing event.

Replace every master-bar tempo array, clearing absent bars, using `Automation.buildTempoAutomation(linear,ratio,bpm,2)`; update score initial tempo from the first point. Materialize/validate all arrays before assignment. New points have default visible/empty-text metadata; removing old tempo labels is part of this explicit replacement. Preserve meter/repeat/section/lyrics/tracks/backing/source/assets. Compare complete normalized authored automations including intended metadata for no-op; identical actions neither append nor truncate redo.

## Pure timing contracts

Create `src/audio/reference-sync-types.ts`:
```ts
type ReferenceEndpoint='entry'|'exit';
interface ReferenceLocation {bar:number;occurrence:number;startTick:number;endTick:number}
interface ReferenceTempoSegment {
  startTick:number;endTick:number;startSourceMs:number;endSourceMs:number;bpm:number;
}
interface ReferenceSyncTiming {
  entryTick:number;exitTick:number;entrySourceMs:number;exitSourceMs:number;
  segments:readonly ReferenceTempoSegment[];
}
```
Export exact pure functions from `src/audio/reference-sync.ts`:
- `referenceSyncTiming(backing:BackingSettings,locations:readonly ReferenceLocation[],durationMs?:number):ReferenceSyncTiming|null`.
- `referenceSourceMs(timing:ReferenceSyncTiming,tick:number):number`.
- `applyReferenceSyncPlan(authored:PlaybackPlan,backing:BackingSettings|null):PlaybackPlan`; legacy returns the same plan object.
- `referenceTimingKey(backing:BackingSettings|null):string|null`; null for legacy, otherwise normalized asset/offset/anchors/bounds, excluding mix.
- `initializeReferenceSync(backing:BackingSettings,authored:BackingTimeline,durationMs:number):BackingSettings`.
- `disableReferenceSync(backing:BackingSettings):BackingSettings`; remove bounds and, only if needed, add the same nonnegative translation to every stored anchor and offset so legacy stored values are valid while physical source coordinates remain exact.
- `moveReferenceEndpoint(backing:BackingSettings,endpoint:ReferenceEndpoint,sourceMs:number,locations:readonly ReferenceLocation[],durationMs:number):BackingSettings`.
- `adjustReferenceSyncBounds(backing:BackingSettings,previous:ReferenceSyncTiming,locations:readonly ReferenceLocation[]):BackingSettings`; backing already has surviving bar remaps.

Mandatory entry/exit pins resolve to the first occurrence start and last occurrence end, not full note duration. Require nonempty actual performed music. Resolve interiors by bar/occurrence/ratio, strictly inside tick/source endpoints, increasing in both dimensions; reject missing/skipped occurrence and duplicate/endpoint seam aliases. Settings shape validation proves finite values, nonnegative physical entry and positive intervals, not decoded EOF. The optional duration argument additionally proves exit≤actual duration. Return detached settings; never mutate inputs.

For adjacent pins derive `bpm=60000*deltaTick/(960*deltaSourceMs)`. Require positive finite intervals, BPM, reciprocal rate and accumulated time; no fixed-practice10–300 restriction. Piecewise constant derived tempos replace all effective authored changes inside each span. Extend first BPM to tick0 and last BPM through full note extent, recompute occurrence milliseconds/full-plan duration, preserving note/MIDI/performed-beat/click ticks and identities. Derived values remain unrounded; display rounding is presentation only.

Add optional derived `PlaybackPlan.playbackEndTick?:number`, mirrored by defaulted Rust Option. It is finite/positive, ≤durationTick and exactly final occurrence end; emitted only for reference mode. Keep full durationTick/durationMs for existing note validation; this separate active end survives backing-PCM omission during export.

Reference mapping is a translation: `sourceSeconds=entrySourceSeconds+effectiveSeconds-T(entryTick)`. Native independently validates every effective tempo span against resolved pins (seconds tolerance1e−7, BPM relative tolerance1e−9), then uses that translation. Full source progression is1s/s at100%, r source seconds/wall second at relative ratio r. Preserve legacy map construction and practice behavior.

Enabling reference first obtains actual source dimensions. Use the existing legacy map at first/last occurrence ticks if0≤entry<exit≤D; otherwise use physical[0,D]. Preserve valid interiors. Absorb an old endpoint anchor only when its source agrees with the chosen bracket; reject other endpoint aliases/outside/crossed points. One setBacking stores the result; do not repeat initialization on reopen. Example: legacy four4/4 bars120BPM=8000ms, source6000ms → reference0..6000 derives160BPM; disabling restores120BPM. Disabling removes/nulls bounds and leaves physical interior coordinates/asset/authored tempos unchanged. If a stored anchor is negative, normalize with delta=max(0,−minimumStoredAnchor), adding delta to every stored anchor and offset together; this preserves physical mapping while satisfying legacy validation. With no anchors delta=0.

## Grace, source gate and transport duration

Entry is the first performed measure body/downbeat. Initial grace0..entryTick remains score-only pre-roll at first derived BPM, with backing silent until entry. Preserve existing null-anchor grace ownership and later relocated grace ticks. The musical exit is exclusive. Live score/backing playback ends there even if note releases extend beyond it. Unrepresented free-time music inside the final occurrence remains included.

Native renderer active duration is T(playbackEndTick) when present; legacy retains maximum score/full-backing end. Seek clamps to active end; ranges/loops beyond it reject; event delivery uses the earlier range/active ceiling so notes/MIDI/clicks at the exclusive exit cannot leak through the current tick tolerance. Preserve count-in/practice behavior.

Gate source frames in[entry,exit) for interpolation, grain/correlation reads and isolated transient insertion, including samples at an exact boundary. Merely silencing final output while reading excluded frames is insufficient. Validate against real decoded frames/sampleRate before voice installation. No asset rewrite, copy or rehash change.

Audio/stem export applies the effective transform at frozen settings even with includeBacking=false. Omission controls PCM participation, not score timing. For active reference timing, capture the frozen backing asset/settings and decode/validate actual source bounds and pin/BPM agreement before clearing settings or omitting voice installation, reusing the existing owned export capture path. Only after validation may includeBacking=false discard PCM participation; playbackEndTick alone is not proof of source bounds. Legacy backing-omitted exports need no new decode. Whole duration is T(activeEnd)/relativeSpeed + requested wall-time tailSeconds, with ≤one output-frame scheduling tolerance. Selected performed segments use effective times and active ceiling. Explicit export tail may contain released score voices/DSP, with no reference audio or new exit/future events.

## Structural replay and source admission

Before each non-settings score command during reference replay, capture old actual performed locations and resolved timing; apply the existing musical edit/bar remap, rebuild timing at that historical point, then:
```text
deltaExtent=(newLastEnd-newFirstStart)-(oldLastEnd-oldFirstStart)
newExitAudioMs=oldExitAudioMs+deltaExtent*oldFinalMsPerTick
```
Keep entry and surviving source-fixed pins; remove deleted-bar anchors through existing remaps, then validate the entire new route. Compare real route/bounds for every score command, including pickup/free-time/meter, repeats/endings/directions, grace/rhythm, staff/voice/track/longest-lane changes and paste/insert/remove. Equal body extent leaves exit fixed. Initial grace shift changes only pre-roll. Extract the existing lightweight performed-location resolver from plan.ts for this purpose; do not invoke full isolated note-lane generation for every history edit or cache a score mutated in place.

Unchanged-prefix append preserves all old times and extends final slope. Interior insertion can change surrounding derived BPM while surviving source pins stay fixed; this is our routine policy, not observed proprietary behavior. Missing occurrences/crossings/nonpositive spans/EOF reject the entire candidate. No virtual EOF brackets or automatic mode fallback. Adjustment is a deterministic derived effect of the one original score command; no extra history step or wrapper. Native history does not replay alphaTab geometry; rebuilt frontend settings are passed to native prepare/export. Reference history's settings-only replay uses full buildDocument-derived settings while retaining current score identity, following the existing paste fallback, so historical bounds are not inferred from final barCount.

Inside serialized DocumentController.editNow, preview first, then validate a changed reference source/timing/route before native apply. Register the active existing NativeBackingWaveformBridge through a single-purpose `setReferenceWaveformBridge(bridge):()=>void` lifetime binding. Read committed asset with current DocumentRevision and buckets1 to get true duration, or reuse a previously verified same owner/source immutable receipt. Recheck bridge identity, document/revision/source/lifecycle after await. No source duration is persisted; no general cache. Native decoded prepare/export independently revalidates EOF. Native direct apply_edit only proves its current syntax/asset/revision checks; arbitrary direct histories are not claimed EOF-validated, and must fail playback/export safely.

New mode requires an already committed editable asset; original embedded audio stays read-only until existing Edit embedded backing. Rejected/no-op/stale/canceled candidates keep history, redo and assets exact. New `editAtRevision(command:EditCommand,expected:DocumentRevision):Promise<void>` checks the captured revision inside the existing queue, then uses editNow. Existing edit callers stay unchanged. Conversions and new UI commits use that method plus active-owner/current guards; they cannot overwrite an intervening queued edit.

## Plan regeneration and notation cursor

A referenceTimingKey change, including transition into/out of mode, forces new generation/prepare with existing stop/range/loop invalidation; gain/pan/mute/solo stay on setMix. Native setMix rejects changed reference timing on an old plan. Authored plan generation remains the existing worker output; applyReferenceSyncPlan transforms once afterward. Keep the authored plan transient alongside the effective plan.

Native timer, waveform, grid and duration use effective time. Rendered notation keeps authored tempo events. Feed alphaTab external output the authored milliseconds at the native performed tick; invert alphaTab seek milliseconds using the authored timeline, then seek that musical tick natively. Do not feed effective milliseconds directly or mutate authored automations as a workaround. Ensure timing remains readable without output device and after preparation guard releases, preserving P15 subscriber/stale-generation protections.

## Explicit conversions

Create `src/audio/tempo-conversion.ts`:
- `syncPointsFromScore(authored:PlaybackPlan,backing:BackingSettings,mode:'replace'|'add',durationMs:number):BackingSettings`.
- `scoreTemposFromSync(score:model.Score,timing:ReferenceSyncTiming,locations:readonly ReferenceLocation[]):RatioTempoPoint[]`.

From score uses every actual authored generated tempo breakpoint and performed occurrence, not whole-bar averages or active reference timing. Pin physical entry E; source(t)=E+authoredT(t)−authoredT(entryTick). Replace installs complete new interiors and computes exit from authored end, preserving entry/offset/asset/mix. Reject outside actual source. Add keeps existing interiors/endpoints and merges by resolved tick: identical time within1e−7ms agrees, different-time collision/crossing rejects; generated endpoint times must agree. Both enter reference mode through one setBacking. The shipped generator emits piecewise values even for isLinear flags; preserve authored flags but do not claim native GP gradual-tempo expansion.

Write score tempos compares every performed copy's entire required per-written-bar BPM function on the union of local breakpoints, including inherited ratio0; absolute BPM agreement tolerance1e−9, so120 versus120.000001 conflicts. Reject incompatible passes without averaging/first-pass choice/unfolding. Compatible maps emit ratio0 in each played bar and internal changes, plus required initialbar0 fallback; terminal exit has no outgoing event. Regenerate candidate performed timing and verify it before one captured replaceTempoAutomations edit. Clear unplayed bars as part of full replacement; do not invent their performed requirements. Keep backing mode/map unchanged. One Undo restores the previous complete authored state.

## GP projection and truthful compatibility

Current export(score) omits backing settings. Add a detached current-document export projection; preserve live score JSON/source/history/settings/assets. Resolve effective backing including original embedded versus explicitnull, clone with existing score/link/archive helpers, then overwrite detached backing/sync points from current settings. Resolve selected committed asset bytes through one narrow revision/source-bound native read, `read_export_backing({document:DocumentRevision,assetId:string})` → `{document,assetId,sha256,bytesBase64}`. Validate actual current applied backing ownership, asset digest and document revision before/after capture; capture under lock, decode/hash outside. Use existing decoded-byte helpers and the query-specific limit frozen below; no arbitrary path access/new media service. Embedded fallback uses existing immutable built bytes. The exact bridge contract is frozen below.

Physical GP sync coordinate is stored−offset; include resolved reference endpoints. Legacy offset-only/partial maps require representable performed boundary points preserving their actual mapping; test grace/terminal ownership. Explicit removal clears detached backing and all sync lists. Preserve unrelated source ZIP siblings; force newly generated `Content/score.gpif` **and active `Content/Assets/backing-track`** to win original-archive collisions in both writer branches. Unreferenced old siblings may remain but cannot reactivate backing.

Import signed physical points s using offset=max(0,−min(s)), stored=s+offset, preserving mapping and old nonnegative storage. Public GPIF ratio tempos/occurrence sync points use44.1kHz frame quantization. Guard signed32-bit initial padding and safe frame offsets before the dependency writer; general absolute source error<1.5frames (0.034014ms), delta error≤one frame, not an unconditional half-frame bound. Audio bytes stay exact.

The dependency exposes no verified GP bracket encoding. Endpoint sync points do not prove GP playback clipping; do not invent private XML. Native .tabplayer brackets can be accepted independently, with GP bracket import/export, backing mix/pitch/filter interchange and native GP8 runtime equivalence explicitly unverified. This gap remains in P16/current ledger even if the bounded native slice passes.

## Interface and transaction design

The existing Export dialog's GP state also has an actual pre-code generated reference: `backing-gp-export-concept.png` (removed before publication), SHA256 `5AB74C5408A5E56E237A3F161791951AE718D91CC969030D2F6211974C218E9D`, with full prompt/provenance in its `backing-gp-export-generated-concept.json` sibling. Root inspected its pixels. Adopt the existing dialog hierarchy, GP-only **Include backing audio** checkbox, associated actionable route error and visible focus; preserve actual modal geometry/error typography. Generated italic error, icon and out-of-range measure example are illustrative. No new shell or audio-format controls in GP mode.

Both real GP publication paths use one pure `projectGpDocument({score,settings,bytes,selection,backing}):model.Score` facade in `src/interchange/backing-projection.ts`, followed by the existing low-level exportGp writer. Inputs are a frozen full original score, effective DocumentSettings, exact backing bytes or null, ExportSelection and explicit include boolean. NativeBridge gains required `readBackingAsset(assetId:string,revision:number):Promise<Uint8Array>` implemented by createDocumentBridge; both DocumentController.export and useExportCoordinator use this existing document boundary. The exact byte-read IPC is `{request:{document:DocumentRevision,assetId:string}}`, with strict nested request and response fields from the GP section. The native read is query-only capped at512MiB raw encoded-container bytes after base64 decoding (including predecode encoded-size check); this is not a universal asset/import limit or streaming API. Asset ID is its lowercase SHA256; verify response identity, digest and bytes before use.

GP selection follows `.analysis/parity/backing-tempo-export-selection-contract.md` `322DDDF9`. Capture full route and physical source function before existing selectScore, then generate the final selected route and replace every selected sync list afterward. Include backing only when the selected performed route has one unique contiguous embedding in the original route, with matching old written-bar mapping, occurrence durations and a uniform tick-origin translation. Full original selection is the identity case; changed pickups, ambiguous repeated passes or separated source windows reject inclusion before publication. For this slice any pre-body grace on a non-identity excerpt also rejects inclusion; full identity keeps the authored original grace route and gets a dedicated roundtrip source-map oracle. Do not fabricate grace ratios, pick a pass or splice audio.

For supported selection, selected source(u)=original source(u+delta), without re-zeroing physical source time. Inject canonical endpoints and all source-slope/selected-authored-tempo breakpoints needed to express the same map, with fresh selected bar/occurrence keys, right-continuous internal seams and one terminal point. Offset-only120BPM/+250ms selecting original bar2 must map selected0..3840ticks to physical3750..5750ms, not−250..1750. Rebuild after selection even for omission so orphan old pass points cannot reach the writer. GP ExportOptions adds optional `backing:boolean`, absence meaning true; dialog exposes the checkbox. A false choice exports existing selected notation/authored tempos with no active backing or sync lists. Do not silently downgrade include; an invalid include remains blocked with an actionable explanation, and notation export remains available by clearing the checkbox. Unreferenced preserved source siblings may remain; the checkbox makes no claim to remove all audio bytes from the archive. Captured revisions/cancellation protect both publication paths.

Freeze view props in `reference-sync-types.ts`: `ReferenceSyncControls {timing:ReferenceSyncTiming|null;edit:ReferenceEditBinding;ready:boolean;onModeChange:(mode:'score'|'reference')=>Promise<void>;onFromScore:(mode:'replace'|'add')=>Promise<void>;onWriteScore:()=>Promise<void>}`. BackingPanel receives optional `reference:ReferenceSyncControls`; BackingWaveform receives optional `reference:Pick<ReferenceSyncControls,'timing'|'edit'>`. Existing consumers retain legacy behavior when omitted. Its effectiveBacking pick includes optional referenceSync. `ReferenceEditOptions` and binding are frozen verbatim in plan Task1. ready requires a real current route and confirmed source dimensions; actions use the captured revision and one lease, never a rendered estimate.

BackingPanel adds Sync timing after mix and before existing anchors: native Timing select **Audio follows score / Score follows audio**, paired Entry(ms)/Exit(ms), concise mode explanation, From score disclosure with Replace sync points/Add sync points, and Write score tempos with accessible consequence “Replaces score tempo changes.” No confirmation modal. Original embedded/loading/score-only states expose no enabled persisted reference editing; source duration/route must be real.

One App-owned endpoint draft session is shared by sidebar numbers and waveform bracket handles; interior P15 session remains intact, with the existing lease excluding overlap. The narrow shared hook lives in `src/audio/useReferenceSyncEdit.ts`; both controls consume its stable binding. `active` identifies endpoint and number/waveform surface; `preview` is the detached BackingSettings; methods `begin(endpoint,surface):boolean`, `update(sourceMs):void`, `commit():void`, `cancel():void`. Inputs are current document/source/settings/generation, visible-surface flags, source duration, route, beginOperation, isCurrent and promise onCommit; exact props are frozen in Task1.

Number focus only selects/readouts; first changed input/arrow starts lease. Preserve fractional originals. Empty/partial/nonfinite text is invalid, never coerced zero; keep last valid plot but invalid drafts cannot commit it. **Enter applies; Escape or blur cancels**, with this concise instruction associated to fields. Enter then blur dispatches once. Own busy does not disable the initiating field or stale its signature; competitors disable. Window blur/hide of initiating surface/pointercancel/lostcapture/source/revision/settings/activation/generation/unmount cancels and releases once. During commit hold lease until settlement; stale settlement cannot publish another document's preview/error. Waveform handle ArrowLeft/ArrowRight use1ms/Shift10ms and matching arrow key-up commits. Number ArrowUp/ArrowDown change the draft by1ms/Shift10ms; number key-up never commits, and Enter is its only apply action. Stop note-entry shortcuts. Pointer-up commits at most once.

Waveform overlays distinct entry/exit brackets and outside-span dimming, interior handles unchanged, compact derived segment BPM lane and selected endpoint footer. Endpoints cannot be deleted as interior anchors. Exact0/D handles and visible keyboard outlines remain reachable at plot edges; labels clip/cull without covering controls. View-only selection/zoom/pan/Fit and menu open/close never edit or transport. Preview updates only local grid/brackets/tempo labels; native playback and source authored model stay committed.

## Verification and completion

Byte-read DTOs/constants live in new `src/export/backing-asset-types.ts` and `src-tauri/src/export_backing.rs`; freeze `MAX_EXPORT_BACKING_BYTES=512*1024*1024` and pure strict `validateBackingAssetReadRequest(value:unknown):asserts value is BackingAssetReadRequest` before actual bridge wiring. Existing NativeBridge.readBackingAsset factory delegates to that validator/response verification in Task8. For GP backing=false, bypass backing-byte capture and source-map generation entirely, then clear detached backing/sync after existing notation selection. This keeps notation export available even when the backing map itself is invalid. Included projection generates the authored route without allowing stale original source sync objects to become a second timing authority.

The GP projection module also exports `gpBackingSelectionIssue(score:model.Score,backing:BackingSettings|null,selection:ExportSelection):string|null`, a pure route/source representability check with no byte read. ExportDialog gains optional `gpBackingIssue:(selection:ExportSelection)=>string|null`; invoke it only for a valid current GP selection with Include backing audio checked, memoized against score/settings/selection rather than playback clock. Display an associated issue and disable invalid submit; clearing the checkbox removes only this include error. Both publication paths still repeat complete projection validation at the frozen revision, so UI preflight is not authority. No asynchronous decoder/asset read during render.

Meaningful literal fixtures at PPQ960 drive both TS/native checks:
- Pins(0,1000ms),(3840,3000),(7680,7000) →120 then60BPM, active6000ms; elapsed3000ms tick4800/source4000. At50%, source4000 occurs after6000ms wall time.
- Same pins stored+120 with offset+120 →identical timing. Offset-only+220 →source900/2900/6900 with unchanged BPM. Offset−120/source0 accepts stored−120 only in reference mode.
- Body120..3960, grace0..120, entry1000/exit3000 →62.5ms silent pre-roll, active end2062.5ms, note end4440 cannot extend it;500ms explicit export tail→2562.5ms.
- 6/8 body2880ticks/3000ms →60quarterBPM and six500ms pulses; pickup/free-time use actual extent.
- Append3840ticks to two-span fixture with D12000 →exit11000, unchanged previous timing, appended60BPM; D10000 rejects before history. Interior insertion policy has literal source-fixed tempo expectations.
- Arbitrary ratios1/3 and3/8 in4/4 →ticks1280/1440, preserved native save/reopen/Undo/Redo and GP ratio fields. Hidden repeated-pass conflict compares full functions, not just explicit keys.
- Long source60000ms/brackets1000..7000 →live/full export6000ms independent of omitted/muted backing;50%+500ms tail→12500ms, source frame at7000 excluded.
- GP p1000.01ms,s2500.02 →FramePadding−44100,FrameOffset66150; reimport1000/2500ms. Current active-audio collision and explicit removal preserve other sibling/base/asset hashes.

Run focused behavioral RED→GREEN per independent task, then coherent types/fmt/resources/whole frontend/native once. Root builds diagnostic executable and runs owned authored-source actual workflow for brackets, key/numeric/cancel/reject/Undo/Redo, conversions/repeats/source-history invariants/save-clean-close-fresh-reopen. Scoped offline/native PCM/transport proves linear time and exclusive gate; real UI clock/seek/notation agreement is separate. Actual960/1280/1600/short-height screenshots compare to this GenAI reference in one batch, fix identified defects once, confirm at most once; no open-ended polish or unrelated old capture reruns.

Fresh source/design and final evidence reviews precede root scoped commits/push. Advance only supported current assessments; preserve all historical fields/baseline and other rows. Maintain truthful source/runtime/GP/platform/shipping distinctions. No full-parity completion claim from this slice.
