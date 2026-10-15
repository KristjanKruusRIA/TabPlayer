# Guitar Pro 8 bounded musical clipboard design

Date: 2026-10-15. Accepted under the user's standing approval to finish parity using parallel workers. This follows the [range](2026-10-15-gp8-range-editing-design.md) and [measure](2026-10-15-gp8-measure-transforms-design.md) interfaces and implements the next bounded part of [the umbrella design](2026-10-15-gp8-feature-parity-design.md). Execute with [the clipboard plan](../plans/2026-10-15-gp8-clipboard.md).

## Outcome and evidence

Add an app musical clipboard that survives New/Open. Copy snapshots selected music; Cut commits one existing eraseSelection/removeMeasures command and replaces the clipboard only after success; Paste embeds the snapshot in one new native command. Saved history must replay with an empty clipboard and without the source document.

This targets E08/E09/E10/E21 and the cross-document part of E11. The [official copy/paste manual](https://www.guitar-pro.com/docs/gp8/score/assistant/copy-paste), cached in `.analysis/parity/public-manual-pages.json`, documents single-track multivoice copying without bar structure, whole-bar multitrack copy/cut with structure, melodic/percussion conversion to rests, repeated paste and six content filters. The choices below are a bounded app workflow; no GP8 runtime observation establishes exact equivalence.

First delivery supports a partial phrase in one voice lane and complete bars with multiple staves/voices/tracks. It does not implement mixed partial-bar multivoice slicing, arbitrary division inside a sustained beat, replacing an active selection, lyric splicing, scale diagrams, OS clipboard/MIDI interoperability or automatic track/staff/voice creation. Whole-bar paste inserts before the target, including when the target bar is empty; GP8's empty-bar fill behavior for whole-bar clips remains open. These limits keep the implementation finite and reviewable without claiming the full inventory is closed.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency or OS clipboard permission changes.
- Root owns shared DTOs/validators, controller/engine/settings replay, App/EditorPanel/ScoreView, source lifetimes, Git, apps/builds and native verification. Workers edit only assigned new modules and tests.
- Copy and selection are not native history. Cut and Paste each change music in one native history entry; repeated Paste has one undo step.
- Validate complete clips, all mappings, all repetitions and all contextual destinations before committing. Failed Cut leaves the previous clipboard and document unchanged.
- Clipboard snapshots contain selected music and required instrument context only: no recursive native Project, unrelated music, source paths/archive siblings, raw lyric sources, backing bytes/assets or document sound graphs.
- Destination source bytes, archive siblings, backing audio, raw lyric text, unrelated notes and document settings remain immutable except the approved bar-index mapping. Preserve note dynamics and valid links through rebuild.
- Keep the approved slate/cream/lime layout and existing note-name/one-based UI conventions. Public roundtrip, native replay, actual MIDI/audio and GP8 runtime compatibility need separate evidence.

## Shared DTOs and public APIs

Root creates `src/editor/clipboard-types.ts` before workers proceed. Import existing BeatTarget, MusicSelection and BarIndexMap rather than duplicating them.

```ts
type ClipboardMode = 'singleTrack'|'multiTrack';
interface ClipboardLink {
  from:number;to:number;kind:'tie'|'slur'|'slide'|'hammerPull';slideOutType:number|null;
}
interface MusicClip {
  format:'TabPlayerClip';version:1;engineVersion:'1.8.4';
  mode:ClipboardMode;kind:'phrase'|'bars';scoreJson:string;links:ClipboardLink[];
}
interface PasteFilters {
  diagrams:boolean;texts:boolean;timers:boolean;trackAutomations:boolean;
  masterAutomations:boolean;sections:boolean;
}
interface PasteDestination {sourceTrack:number;track:number;staffMap:number[]}
interface PasteOptions {
  target:BeatTarget;destinations:PasteDestination[];count:number;
  placement:'currentBar'|'beforeBar';filters:PasteFilters;
}
type ClipboardCommand = {type:'pasteMusic';clip:MusicClip;options:PasteOptions};
interface PreparedMusicPaste {score:model.Score;barMap:BarIndexMap}
interface ClipboardPanelProps {
  score:model.Score;target:BeatTarget;selection:MusicSelection|null;
  clip:MusicClip|null;busy:boolean;
  onCopy:(mode:ClipboardMode)=>void;onCut:(mode:ClipboardMode)=>void;
  onPaste:(options:PasteOptions)=>void;
}
```

Root exports these types. Native command/clip/options/filter/link/destination envelopes are strict, including required nullable slideOutType. All indices are finite integers 0..u32::MAX; count is 1..1000. Every filter is a required boolean. Links use unique existing **note** IDs in the payload, not IDs from another model kind; slideOutType is null except for slide, whose type must be Shift/Legato. IDs must be unique within each model kind; Note and Beat IDs may coincide legitimately. SingleTrack has exactly one payload track; phrases are singleTrack with exactly one staff/voice. No recursive EditCommand or Project is stored.

Public snapshot APIs in `src/editor/clipboard-source.ts`:

```ts
makeMusicClip(score:model.Score,selection:MusicSelection,mode:ClipboardMode):MusicClip
readMusicClip(value:unknown):MusicClip
musicClipSelection(score:model.Score,selection:MusicSelection,mode:ClipboardMode):MusicSelection
```

Public paste API in `src/editor/clipboard-paste.ts`:

```ts
preparePasteMusic(score:model.Score,command:ClipboardCommand):PreparedMusicPaste
```

It returns a detached candidate plus the original-to-result bar map; it never mutates the input score/command/clip. The returned score may require root's normal final rebuild. Source preparation, paste core, store/UI and root integration have distinct ownership; no worker edits existing range/measure/fingering modules.

makeMusicClip and serialized Cut share musicClipSelection, so canonical end-at-zero ranges and multitrack expansion cannot disagree between copied music and removed music.

## Snapshot scope, privacy and validation

Reuse validateMusicSelection/resolveSelectionBeats/resolveSelectionNotes. SingleTrack bars copy that selected track's complete staves/voices and selected bars. SingleTrack partial range requires one lane. Note selections require one lane; span from earliest through latest selected beat, keep only named note members, and use plain rest gaps for unselected intervening beats. Gaps carry rhythm only, without their unrelated text/chord/gesture/automation data. Reject mixed lanes in a partial phrase with a clear scope error. MultiTrack expands any selection to complete inclusive bars of its named tracks and includes their staves/voices. Cut uses this expanded scope and warns that global bar removal affects other tracks too.

Use a detached public model clone via scoreFromJson. Build a **new Score** with only the selected/rebased masters/tracks/staves/voices/beats; do not serialize the original whole score with a selection field. Root score metadata is empty/default. Prune chord dictionaries to referenced chord IDs. Preserve selected instrument/tuning/capo/sounding-transpose/custom articulation context, note dynamics and supported effects. Clear layout/line-break arrays referring to omitted bars; omit backingTrack, syncPoints and every Beat.lyrics. Do not call copyGpInterchangeSource on the clipboard snapshot: archive provenance/raw lyric weak maps/binary audio belong to the source document. Source document names/paths and unrelated music must never appear in scoreJson. Selected track names and selected note text are legitimate selected music, not a reason to copy root metadata.

`scoreJson` is pinned alphaTab 1.8.4 JsonConverter.scoreToJson output, not GP interchange. Rebase bar indices to zero; phrase first selected beat starts at zero and its duration is the sum of selected complete beats/rest gaps, independent of underfull source master capacity. Preserve complete beat rhythms including supported tuplets/dots; no beat is sliced. Internal links are captured explicitly; outward links are removed. A former tie destination becomes independently sounding with isTieDestination false. Reject a clipped continued bend that needs an external origin instead of inventing a bend flattening policy. Preserve nonlinked solo slide-out modes. Fresh IDs are allocated only when pasting, so repeated copies do not alias.

readMusicClip checks exact envelope, supported version/engine, valid JSON syntax and a maximum **128,000,000 UTF-8 bytes** for scoreJson, matching the installed importer default. Before constructing the public model, check its structural arrays/counts, finite JSON numbers, integer IDs, alignment, voice count 1..4 and no embedded backing/sync data; after scoreFromJson check note/link existence, valid rhythm/pitch/articulation and scope constraints. Use the public converter for pinned model fields rather than inventing a second comprehensive alphaTab schema. Unknown outer/native fields reject. Reject unsupported/invalid model data; do not silently normalize it into different music. Defensively clone the accepted envelope. Root's Rust validation checks strict DTOs, string byte budget and JSON syntax; score-dependent semantics are checked by the frontend candidate before native history writes, consistent with existing edits.

Context restrictions: reject similes whose sounding predecessors are outside the copied range. For MultiTrack reject partial repeat groups/endings and direction-bearing clips in this first delivery; moving/copying direction targets or materializing contextual similes needs separate proofs. Fully internal repeat groups may be copied as bar structure. SingleTrack deliberately omits global repeat/direction/section/tempo structure, so a riff inside a larger repeat is copyable without importing that repeat. These are visible clipboard limits, not silent loss of promised bar structure.

## Destination, placement and filters

Each source track has one unique existing destination track. staffMap has one unique existing destination staff for each source staff. For bar clips, destination has every copied voice index; phrase voice0 maps to target.voice and its sole mapped staff must equal target.staff on target.track. Default UI mapping is contiguous destination tracks from target.track and same-index staves. Invalid/fewer tracks/staves/voices reject before mutation. Keep destination tuning/instrument/sounds/mixes and logical channels; source playbackInfo is context for pitch interpretation, not replacement track setup.

Bar clips require beforeBar placement; target.bar is an existing bar, target.beat is ignored. Insert clipBarCount*count bars globally through the existing measure API. SingleTrack uses inherited destination meter/key/clef and verifies copied rhythms fit that meter; source master structure is not applied. MultiTrack supplies copied meter/key/free-time/repeat/bar structure for inserted bars; master-tempo and sections still follow filters below. Unmapped tracks receive inherited empty bars. Reject copied repeats nested into a destination repeat context until independently supported. Source directions remain restricted above. Enforce the measure API's 1000-inserted-bars command budget in addition to count1..1000; reject multiplication overflow or larger expansion before allocating. Existing large scores remain readable.

Phrase clips require currentBar and start at target.beat. This first version fills a trailing rest/empty suffix in that destination voice; it never overwrites or shifts sounding destination notes. Retain earlier beats/other voices/staves. Pack complete copied beats at the cursor; advance to the next available wholly rest/empty destination voice when needed. Before encountering a nonempty voice or score end, insert the remaining required bars as one contiguous block, using inherited meter. A copied beat that does not fit a partial remainder advances to the next bar, leaving an exact rest gap; a beat longer than a complete target bar rejects until tie-splitting exists. Residual rests use exact supported duration/dot decompositions; reject an unrepresentable remainder rather than changing time. Free-time phrase placement and mixed partial multivoice phrases are deferred.

Phrase fill may replace rest rhythm, but it must preserve destination data outside copied music. If an existing filtered-out annotation or non-DSP automation has no exact beat onset after reflow, reject that destination; do not move it approximately. Track-wide DSP events retain their bar-relative ratios independently of rest carriers. This explicit restriction keeps insertion safe while detailed event-carrier rewriting remains open.

Paste always includes music/rhythm. The six filters are additional families: diagrams copies referenced chord diagrams (scale diagrams remain open); texts copies Beat.text; timers copies showTimer; trackAutomations copies instrument/bank/volume/pan and supported sustain markers; masterAutomations copies modeled master tempo changes; sections copies section markers. SingleTrack requires masterAutomations=false and sections=false. All other defaults are true; MultiTrack defaults all six true. A false filter excludes source data and does not delete existing destination data. Do not label current master-tempo support as complete master volume/pan parity.

Collect GP volume/pan from trackMixAutomations, independently of its carrier beat. Clip/remap by its actual source bar-relative ratio in the half-open copied time span, then place by destination written bar/time. Preserve finite fractional ratios, linear/text/visibility flags; MIDI rounding occurs only at output. Ordinary instrument/bank events remain at copied beat onsets; sync-point Bank payloads are backing data and are excluded. Preserve fades/gestures independently of controller filtering.

Before insertion/fill, capture destination tempo/program/bank/volume/pan/sustain state at the untouched suffix. If copied state changes would leak into that suffix, restore the original state there unless its explicit ratio-zero event overrides it. Never leave later destination music playing the source clip's final instrument or tempo by accident. If no processed beat exists for an exact program/bank boundary, reject instead of moving the event or dropping grace-note sound. This follows the existing measure transform's boundary constraints.

Contradictory program/bank streams across processed lanes in an affected or restored suffix bar reject: the pinned generator can suppress their effective MIDI events through its lane-local state cache. Identical streams and supported same-lane changes remain valid. Duplicate incoming tie ownership also rejects in this bounded clip schema; ordinary score cloning preserves those public-model relationships without flattening their playback.

## Instrument conversion and links

Melodic-to-melodic preserves actual sounding pitch including source capo/sounding offset. Pitched destination writes octave/tone with its destination sounding offset; stringed destination uses planFingering with preferred source string or null and fixed existing destination notes when applicable. The solver supports 1..12 strings; empty requests return [], preferredString may be a positive safe source-string integer exceeding the destination count, and fixedString preserves the current destination placement. Preserve written accidental only when it still describes the converted pitch; otherwise Default.

Simple guitar/piano/bass transfers work. Reject conversion that cannot faithfully retain active harmonic/bend/linked-slide/hammer/rasgueado/string-only gestures instead of silently flattening their sound/notation. Same-family compatible stringed paste retains those techniques if resulting constraints pass. Melodic-to-percussion or percussion-to-melodic transfers rhythm as rests, as documented; remove note-specific effects/links with the removed notes. Drum-to-drum resolves the source standard/custom articulation by actual registry entry. Remap to a complete equivalent destination entry or append a deep-copied custom articulation without altering existing entries; never reuse a numeric custom ID solely because it exists in the destination. Preserve output pitch and notation symbols, not just a label. No source/destination track channel reassignment occurs.

Allocate fresh Voice/Beat/Note IDs for every repetition and restore only links whose endpoints were copied. Reserve every destination and already-prepared ID per model kind; accept constructor-generated IDs only when unused, because persisted source IDs need not match the current process counter. Validate same-staff/voice/forward/pitch/string/next-note constraints after conversion; reject incompatible links atomically. Per-note dynamics survive scoreFromJson. Neither returned objects nor mutable effects/bend points/chords/articulations may alias the source clip, source document or another repetition.

## Core/root lifetime boundary

preparePasteMusic makes a detached **destination** clone with scoreFromJson, captures/restores its links, and immediately calls copyGpInterchangeSource before structural edits. That preserves destination archive siblings/raw lyric sources/backing bytes; it must never attach clipboard source provenance. It uses planMeasureMap/applyMeasureEdit and mapLyricsMeasures on that candidate for the one planned global insertion, then installs prepared music and returns the cumulative BarIndexMap. No insertion returns an identity map. It does not mutate document settings or native history.

Root replaces the current replay score with this candidate, applies mapBackingMeasures to document and embedded backing settings, performs the existing final rebuild/timer/managed-lyric reflow, and validates effective backing anchors before native commit. Raw lyrics are not copied: existing destination text/comments/slots/visibility/managed flags remain exact except mapped start bars. Unmanaged destination beat lyrics outside a filled rest suffix retain their assignments. Invalid surviving backing occurrence rejects the paste. Preserve sourceBarCount/track identities; no track addition/removal is part of this delivery.

For correctness with existing settings-only replay, if history contains pasteMusic, root's replayDocumentSettings derives settings/maps through buildDocument(project), retaining the current canonical score and embedded-byte objects. The caller has changed only settings history, so music is unchanged; retaining these identities prevents settings undo/redo from restarting playback. This avoids persisting a redundant derived bar map or recomputing fill decisions without their score.

## Controller, store and UI

`ClipboardStore` in `src/editor/ClipboardStore.ts` owns a private MusicClip|null with get():MusicClip|null and set(clip:MusicClip):void. It stores/returns deep copies. App creates one store for its lifetime, independent of DocumentController replacement/epoch; New/Open never clear it. No OS clipboard tools/plugin or text clipboard JSON are introduced.

Root adds DocumentController.copyMusic(selection,mode):Promise<MusicClip> and cutMusic(selection,mode):Promise<MusicClip>. Both run in the existing serialized run queue against committed score. For Cut, construct/validate the snapshot first, then use one eraseSelection (singleTrack) or removeMeasures (multiTrack expanded bars), returning the clip only after native commit. Extract the current edit body into private editNow(command,asset?) for use inside the existing run lock; do not call public edit from inside run, which would deadlock the queue. Existing public edit delegates to run(()=>editNow(...)) without behavior changes. Root stores the returned clip only after success; failures preserve previous store/history. Paste uses existing controller.edit with the embedded clip snapshot.

Playback invalidation follows a successful native commit and precedes frontend score publication. Rejected native edits, history changes and document replacements preserve the existing playback preparation. Successful paste clears indexed chord-member selection; score shortcuts ignore dialog descendants as well as text-entry controls.

`ClipboardPanel` consumes ClipboardPanelProps. Copy/Cut expose Single track vs Multitrack; show scope/global cut implications. Paste defaults phrase/currentBar or bars/beforeBar, displays track/staff mappings, count, six filters and concrete restrictions. It submits one PasteOptions object against the store snapshot. Ctrl/Cmd+C/X/V and Shift variants select the documented single/multitrack/special actions; input/select/textarea/contenteditable keep normal text editing. Busy disables actions so stale selections do not queue hidden edits. Paste clears stale indexed selection after success; Copy does not dirty or seek. Clipboard content is never logged or displayed as raw JSON.

## Acceptance and limits

RED tests cover privacy/scope, internal/external links, custom drum IDs, conversion, aliases, each filter, repeated one-step history, Cut failure, New/Open persistence, empty-store save/restart replay, fractional DSP positions, suffix state, raw lyrics/backing/archive preservation and invalid last repetition/mapping. Independently decode MIDI and inspect GPIF; native desktop verifies the visible workflow and full restart. Record exact scope limitations and leave E08–E11/E21 partial where listed; do not call app clipboard external MIDI compatibility or parser roundtrip full GP8 parity.
