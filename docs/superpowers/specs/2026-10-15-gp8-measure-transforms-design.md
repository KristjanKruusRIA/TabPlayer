# Guitar Pro 8 global measure transforms design

Date: 2026-10-15. Status: accepted bounded delivery under the user's standing parity approval. This refines [the umbrella design](2026-10-15-gp8-feature-parity-design.md) and follows [the measure-transforms plan](../plans/2026-10-15-gp8-measure-transforms.md).

## Outcome and limits

Add arbitrary global insertion and inclusive range removal, preserving every track/staff/voice and musical/source relationships. Historical inventory E07 is the direct target. The resulting index map is the later clipboard E09/E21 foundation; clipboard starts afterward using stable interfaces. Existing appendMeasure/removeMeasure commands keep their recorded replay behavior.

The [official bars manual](https://www.guitar-pro.com/docs/gp8/score/bars) documents insert-before-cursor and global track synchronization; [copy/cut](https://www.guitar-pro.com/docs/gp8/score/assistant/copy-paste) documents multitrack cut removing global bars. Cached bodies exist in `.analysis/parity/public-manual-pages.json`. Boundary automation policy below preserves retained music; it is a specified app policy, not verified exact GP8 runtime behavior.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared DTOs/validators, engine/router, App/EditorPanel/ScoreView, source lifetimes, Git, apps/builds, native verification and final integration. Workers edit only assigned modules and tests.
- Validate the entire command and every destination before mutation. Each mutation is one native history entry; selection changes never dirty the project.
- Source files, GP archive siblings, backing bytes, raw lyric text and unrelated music remain immutable. Preserve per-note dynamics and surviving note relationships through rebuild/replay.
- Keep the approved slate/cream/lime layout. Use note names in user pitch displays and one-based labels for zero-based internal indices.
- Public-model retention, native replay, notation, actual MIDI/audio output and GP8 runtime compatibility require separate evidence; full parity remains open.

## Exact shared interfaces

Root stages `src/editor/measures-types.ts` before workers use it:

```ts
type MeasureCommand =
  | {type:'insertMeasures';beforeBar:number;count:number}
  | {type:'removeMeasures';firstBar:number;lastBar:number};
interface BarIndexMap {oldToNew:Array<number|null>;inserted:number[]}
interface MeasureTransformPanelProps {
  score:model.Score;bar:number;busy:boolean;
  onEdit:(command:MeasureCommand)=>void;
}
```

Indices are finite integers0..u32::MAX. `beforeBar` accepts0..current count; equal count appends. Insertion count1..1000 per command is an explicit UI/history limit; it does not restrict reading existing large scores. Removal indices are inclusive, existing, ordered, and cannot remove every measure. Commands and nested objects use exact TS validation and strict Rust serde shapes. No implicit recursive batch commands.

Worker-owned `src/editor/measures.ts` exports:

```ts
planMeasureMap(barCount:number,command:MeasureCommand):BarIndexMap
applyMeasureEdit(score:model.Score,command:MeasureCommand):boolean
mapBackingMeasures(backing:Pick<BackingSettings,'anchors'>|null|undefined,map:BarIndexMap):void
```

The pure planner returns one entry for every old bar, null for a removed bar, and sorted newly inserted indices. Mapping is injective and surviving order remains unchanged. `applyMeasureEdit` returns false for unrelated command types; recognized invalid input throws before mutation. It mutates notation/model structure and line breaks only; root applies raw-lyric and document/embedded-backing adapters using the same precomputed map. `mapBackingMeasures` mutates only the supplied anchor array, without replacing other backing settings fields.

## Insertion

Insert blank bars globally. Inherit meter, free-time, common-time, triplet feel and deeply copied custom beaming from preceding master bar, or first master bar for insertion at0. Each staff inherits clef/key/mode/clef-octave context from its preceding/first bar. Preserve its existing voice count. In ordinary meter, voice0 contains meter-filling explicit denominator-unit rests, other voices have empty carriers. A free-time inserted bar has one empty carrier in each voice; do not invent a performed duration.

Do not duplicate repeat/endings/directions/sections/fermata/timers/text/chords/tempo/sync points into blank bars. Existing music/events move with their original bar. Insertion within an intact repeat group joins the new bars to that repeat. At index0 seed the new first bar with the old score's effective initial tempo at ratio0 so a moved old first tempo does not leave the lead-in undefined. Track playbackInfo remains unchanged.

Rebuild all bar/master/voice parent, index and previous/next references through the existing safe model conversion; no alphaTab dependency changes. Surviving note identities and links persist through root capture/restore. Rest constructors use public model values; do not reuse source beat/automation/beaming objects across inserted bars.

## Removal and inherited state

Detach every incident relationship of removed notes in both directions. Surviving internal links remain connected; no dangling isTieDestination/hammer/slide flags or bend origins. Delete only selected global bars and their explicit events. Preserve surviving note dynamics, geometry-independent IDs, effects, annotations and lyric assignments.

Before removal, capture effective state at the start of the first surviving suffix bar: master tempo; each track's program/bank/volume/pan; each staff's held sustain. Restore a ratio0 event/state at that suffix's new start only for families without an existing explicit start event there. This preserves the retained suffix's audible context. If deleting through the end, add no suffix event. Earlier retained prefix state is unchanged. Events inside removed bars disappear; a later Cut command will snapshot them before this operation.

Capture track DSP volume/pan by **bar-relative ratioPosition**, sorted by bar/ratio regardless of carrier beat. The imported `DSPParam_11/12` objects can sit on a late beat while their actual ratio is.25. Preserve all surviving fractional positions, linear flags, text and visibility. Use the existing `trackMixAutomations` and `isGpMixAutomation` contracts. Non-DSP instrument/bank/ordinary beat automation keeps its established beat-relative semantics. Linear flags are retained, but existing continuous-ramp playback limitations stay open; effective boundary value here is the held preceding breakpoint, not invented interpolation. Preserve exact source events, removing no fade/swell events incidentally.

Sustain is per staff; an explicit Up/Down at the surviving boundary takes precedence over inherited held state. Hold markers do not count as a new Up/Down state change. Do not add duplicate controller events when an explicit ratio0 event exists on another staff of the same track.

## Contextual notation guards

Validate guards before mutation. A retained single simile must still point to the same original preceding musical bar; a retained double pair must stay adjacent and retain both original predecessor bars. Reject insertion/removal that splits a double pair or changes these sources. Materializing contextual similes into real notation is deferred; do not reuse export excerpt materialization as an editor mutation without its own complete music/link/lyric/controller proofs.

Reject removal intersecting only part of an existing repeat group, including alternate endings, when the retained structure would be orphaned. Removing a complete group is allowed. For directions, use a conservative first policy: if removed bars contain any directions and surviving bars also contain any directions, reject with an explicit direction-context error; a later target-aware normalization can relax it. Moving intact direction-bearing bars by insertion/removal elsewhere preserves their symbols. This guard avoids inventing a marker repair policy. It does not close repeat/direction-runtime gaps.

## Shared bar index mapping

The measure worker maps every track.lineBreaks set: drop removed positions, move survivors; do not create breaks for inserted bars. Root uses the same `BarIndexMap` for document backing, embedded backing settings, raw lyric offsets and view selection.

Backing anchors in removed bars are removed; surviving anchors retain occurrence, ratio and absolute audioMs and follow their mapped bars. offsetMs/mix/assetId and binary audio remain unchanged. After rebuild, run existing `validateBackingAnchors` against the resulting performed repeat layout. An invalid surviving occurrence rejects the whole candidate; do not silently select a different occurrence. The identical mapping must be applied in `buildDocument` and settings-only `replayDocumentSettings`, including redo after a settings edit.

Root creates `src/editor/lyrics-measures.ts` after the lyrics batch joins:

```ts
mapLyricsMeasures(score:model.Score,map:BarIndexMap):void
```

Call before mutating bar arrays, when weak-map sources still belong to current tracks. For each raw source line: map a surviving startBar; if removed use the first surviving successor's mapped bar, else the last remaining bar. An imported start beyond the score retains its distance beyond the final bar, shifted by the net bar-count change; reject uint32 overflow before mutation. Preserve exact text (comments, whitespace, CR/LF), verse slots, visibility and managed flag using `getLyricsSource`/`setLyricsSource`. Do not edit lyrics.ts or invent a second lyric store. Unmanaged distributed lyrics move with existing beats. After rebuild, existing managed reflow uses mapped raw starts. Full clones call `copyGpInterchangeSource` immediately before any reordering/deletion; it carries raw sources, archive siblings and binary backing omitted by JSON.

## Root UI and replay

`MeasureTransformPanel.tsx` consumes `MeasureTransformPanelProps`. Provide count1..1000, Insert before, Insert after (beforeBar=bar+1), and inclusive first/last removal controls, all with one-based labels and disabled busy state. New command history is separate from legacy Append/Remove buttons until root intentionally routes new user actions to new commands. Errors are inline and leave current document unchanged.

Root prebuilds derived score state, plans the map, validates raw-source offsets/context/backing candidate, applies notation and auxiliary mappings, then rebuilds. Resulting selection follows its surviving bar; a deleted selected bar selects mapped successor, else last remaining bar. Clear stale note-range selections instead of silently moving their indexed notes to new music. `DocumentController.edit` records a single native command only after candidate success. Undo/redo/restart recompute the same map from the score at that point in history.

## Acceptance and open scope

RED fixtures cover global alignment with2staves/4voices, index0/tail/range cases, deep-copy/nonaliasing, orphan link cleanup, raw lyric mapping, fractional DSP events on late carrier beats, boundary tempo/program/bank/CC7/CC10/sustain, source/backing hashes and settings-fast-path equivalence. Root verifies actual native controls, one-step undo/restart, GP/MIDI output and private corpus source immutability, then requests independent review. Measure context restrictions remain visible E07 limits. Clipboard, external MIDI clipboard, contextual simile materialization, continuous controller ramps and unrelated playback parity stay open.
