# Guitar Pro 8 selections and range editing design

Date: 2026-10-15. Status: accepted bounded delivery under the user's standing approval to finish parity using parallel workers. This refines [the umbrella design](2026-10-15-gp8-feature-parity-design.md); execution follows [the range-editing plan](../plans/2026-10-15-gp8-range-editing.md).

## Outcome and limits

Add an editable music selection, atomic Erase/Transpose/String Move/Re-finger operations, and selected-string let-ring/palm-mute assistants. Keep the existing beat cursor, selected chord-note inspector and approved layout. Selections are independent of playback/practice ranges.

Relevant historical inventory rows are E02/E03/E12/E13/E14/E16; this supplies multivoice editing groundwork for S10/S11 and note-shift groundwork for U08. It does not finish voice colors/move/swap, arbitrary cuts inside a sustained note, key/chord/diatonic transpose, retune/capo refingering, or GP8 optimizer equivalence. Clipboard E08–E11/E21 begins after these interfaces stabilize; no clipboard feature is included here.

The cached official manual documents drag/resize selection, Ctrl/Cmd+A and triple-click track selection, semitone shifts, and range/string assistants. References: [selection](https://www.guitar-pro.com/docs/gp8/basics/first-steps/click), [note symbols](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), [assistants](https://www.guitar-pro.com/docs/gp8/score/assistant/note-score-assistants), [transpose](https://www.guitar-pro.com/docs/gp8/tools/tools-transposition). Bodies are retained in `.analysis/parity/public-manual-pages.json`; no new target execution establishes these implementation choices as exact GP8 behavior.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared DTOs/validators, engine/router, App/EditorPanel/ScoreView, source lifetimes, Git, apps/builds, native verification and final integration. Workers edit only assigned modules and tests.
- Validate the entire command and every destination before mutation. Each mutation is one native history entry; selection changes never dirty the project.
- Source files, GP archive siblings, backing bytes, raw lyric text and unrelated music remain immutable. Preserve per-note dynamics and surviving note relationships through rebuild/replay.
- Keep the approved slate/cream/lime layout. Use note names in user pitch displays and one-based labels for zero-based internal indices.
- Public-model retention, native replay, notation, actual MIDI/audio output and GP8 runtime compatibility require separate evidence; full parity remains open.

## Exact shared interfaces

Root stages `src/editor/range-types.ts` before parallel work. It imports existing `BeatTarget` and `IndexedNoteTarget`, and type-only `model` from alphaTab; it owns every type below so fingering and selection workers never race on type files.

```ts
interface VoiceAddress {track:number;staff:number;voice:number}
interface MusicPoint {bar:number;tick:number}
interface BeatRange {start:MusicPoint;end:MusicPoint;lanes:VoiceAddress[]}
type MusicSelection =
  | {kind:'range';range:BeatRange}
  | {kind:'notes';notes:IndexedNoteTarget[]}
  | {kind:'bars';tracks:number[];firstBar:number;lastBar:number};
type RangeCommand =
  | {type:'eraseSelection';selection:MusicSelection}
  | {type:'transposeSelection';selection:MusicSelection;semitones:number}
  | {type:'moveSelectionStrings';selection:MusicSelection;direction:'higher'|'lower'}
  | {type:'refingerSelection';selection:MusicSelection;maxFret:number}
  | {type:'setSelectionSustain';selection:MusicSelection;strings:number[];kind:'letRing'|'palmMute';enabled:boolean};
interface FingeringRequest {
  note:model.Note;pitch:number;preferredString:number|null;fixedString:number|null;
}
interface FingeringPlacement {note:model.Note;string:number;fret:number}
interface RangePanelProps {
  score:model.Score;target:BeatTarget;selection:MusicSelection|null;busy:boolean;
  onSelection:(selection:MusicSelection|null)=>void;
  onEdit:(command:RangeCommand)=>void;
}
```

All new nested objects have exact field shapes. Indices/ticks are finite integers0..u32::MAX. `notes`, `lanes` and `tracks` are nonempty; reject duplicate addresses/lanes/tracks rather than applying twice. Validate existing tracks/staves/voices/bars/beats/notes; a lane must exist throughout its addressed bars. Voice count stays1..4. Strings are integers1..staff string count; `strings` is nonempty and unique. No new root-level generic batch-command or recursive history type is introduced.

A range uses written bar-relative ticks, **960 ticks/quarter**, start inclusive/end exclusive. Both point bars exist, start<end by `(bar,tick)`, and tick is within that bar's duration. For ordinary bars use nominal duration; for free time use maximum actual written duration of selected lanes. Canonicalize an internal end-of-bar to next bar/tick0 when the next bar exists. Empty/free-time bar selections use `kind:'bars'`, avoiding artificial nonzero durations. Bar selections are inclusive and include all staves/voices of the named tracks.

## Selection resolution

Worker-owned `src/editor/range-selection.ts` exports:

```ts
validateMusicSelection(score:model.Score,selection:MusicSelection):void
resolveSelectionBeats(score:model.Score,selection:MusicSelection):model.Beat[]
resolveSelectionNotes(score:model.Score,selection:MusicSelection):model.Note[]
rangeFromBeats(score:model.Score,from:BeatTarget,to:BeatTarget,lanes:VoiceAddress[]):BeatRange
selectionForBars(score:model.Score,tracks:number[],first:number,last:number):MusicSelection
selectionForTrack(score:model.Score,track:number):MusicSelection
```

Resolvers do not mutate; output order is track/staff/bar/voice/beat/note. Range membership follows **attack onset** in the half-open window. A sustained note beginning earlier is not implicitly edited. Include all chord members for a range; a `notes` selection edits only its named members. Beat resolution of a note selection deduplicates containing beats without widening note resolution. Bars include rests/empty carriers as boundaries, although those contribute no note mutation. `selectionForBars` returns `kind:'bars'`; `selectionForTrack` returns that variant spanning all its bars. `rangeFromBeats` normalizes reverse drags to earlier onset through later endpoint's end; it rejects an empty-only endpoint and returns a range, not a selection wrapper.

Grace beats retain source order. Before-beat and on-beat grace groups join their associated nongrace attack selection; do not use the incidental equal playbackStart ordering as their definition. Use actual model grace grouping/beat linkage after a fresh rebuild. A grace-only explicit note selection is valid.

## Atomic range operations

`src/editor/range-edits.ts` exports `applyRangeEdit(score:model.Score,command:RangeCommand):boolean`. Resolve all note objects and validate complete proposed changes before assigning fields/removing notes. It returns false only for an unrelated command type; invalid recognized commands throw. Preserve existing style rather than refactoring adjacent single-note modules.

Erase removes only resolved notes with two-way link detachment. Empty resulting beats become explicit rests; beat durations/annotations/gestures/automations and other chord members remain. It never deletes beats or bars.

Transpose takes integer semitones-127..127 excluding0. Pitched notes shift written octave/tone. Stringed notes prefer the same string/fret+delta, then use collision-free feasible string assignment. Reserve unselected chord strings. Both base and final sounding harmonic pitch stay0..127; do not treat a percussion articulation as pitch. Reject any percussion note in a transpose selection atomically. Shift selected trill absolute pitches by the same delta; preserve bend intervals, dynamics and other effects. Reset the selected note's forced accidental to Default because its old forced spelling need not describe the new pitch. Existing transposed-trill playback defects remain separately open and need explicit literal-output checks.

Internal links survive when their invariants hold. Transposing one side of a boundary tie detaches that boundary tie; it never silently changes an unselected note's pitch. Internal equal-pitch ties stay tied. Slurs can cross a selection boundary. String Move/Re-finger reject a changed string when a tie/hammer/linked-slide reaches an unselected note; internal same-string links must still be forward/next-note/same-string after the proposed change, or the whole command rejects. Do not silently drop such techniques.

String Move uses the immediately adjacent string in sorted `(open sounding pitch,model string number)` order; `higher` raises open pitch, `lower` lowers it. Reject equal-pitch ambiguity, unavailable adjacent string, negative fret or collision. Compute and validate these fixed adjacent destinations directly in range-edits.ts; `FingeringRequest.fixedString` reserves an unchanged source note and is not a request to relocate it. Move all selected notes together; do not skip over occupied strings. Preserve exact sounding pitch and effects.

Sustain assistant requires stringed melodic selected lanes; mixed pitched/percussion lanes reject. Apply only resolved notes whose model string is in `strings`; other strings/notes stay unchanged. `enabled` writes only isLetRing or isPalmMute. No rhythmic/meter/transport edits are part of this assistant.

## Fingering engine

Worker-owned `src/editor/fingering.ts` exports:

```ts
planFingering(staff:model.Staff,requests:FingeringRequest[],maxFret:number):FingeringPlacement[]
```

The function is pure and handles one simultaneous chord on1..12strings, matching the existing tuning UI. Reject unsupported string counts. `maxFret` is integer1..127; movable candidate frets are0..maxFret. The Re-finger UI defaults24; transpose fallback uses127. Request pitches are finite integers0..127; fixedString is null or an existing string number. preferredString is null or a positive safe integer, allowing a source-instrument string preference outside the destination string count. Normalize assignment-independent preference constants to avoid precision loss. Requests include unselected existing notes with fixedString set to their current string. Selected movable notes use null; Re-finger's constrained linked notes use their original string. Fixed requests preserve exact original string and legal fret0..127, even when their fret exceeds maxFret. Output includes fixed placements unchanged and preserves request order; an empty chord returns an empty plan. Reject invalid requests, repeated note objects, duplicate fixed strings, or no complete assignment before any source mutation. Editor selections themselves remain nonempty.

Tuning for model string s is `staff.tuning[staff.tuning.length-s]`, plus capo, minus sounding transposition. With current standard tuning, model string1 open sounds40, not64. Check candidate outputs using detached model.Note instances attached to the destination staff with the source harmonic fields. Natural harmonic output is independent of fret in alphaTab: reject a same-harmonic operation without an exact sounding match; do not flatten it silently.

The pure solver minimizes per-center assignment cost for integer fret center0..maxFret: sum `10*abs(fret-center)+abs(string-preferredString)`, omitting the preferred-string term when null. Use string-mask dynamic programming so a greedy first assignment cannot strand a later note. Fixed requests admit only their current string/fret when their sounding output equals requested pitch. Choose minimum total cost, then lower center, then lexicographic string vector in request order; when objective/center/string vector are equal, choose lexicographically lower fret vector for deterministic natural-harmonic ambiguities. This solver has no passage state.

For automatic passage Re-finger, `range-edits.ts` visits beats in musical order. Linked tie/hammer/slide notes are fixed to original strings in this first version. Each beat uses the pure per-chord optimum above. It yields deterministic playable positions; global hand-travel optimization and unrestricted linked-passage refingering remain open E14 limits. Every moved note retains its ID, dynamics, effects and sounding pitch.

## View behavior and preservation

`RangePanel.tsx` uses `RangePanelProps`, providing Select bar/track/all, lane/track scope, Erase, semitone±1/octave±12, explicit semitone input, String Move, Re-finger/max fret, and string-filtered sustain actions. Display resolved count and error messages. Selection state lives in App separately from BeatTarget; repair or clear it after an edit/document replacement rather than retargeting stale note indices silently.

Root wires click, Shift extension, Ctrl/Cmd-click chord-member toggle, drag and endpoint handles; Escape clears; Ctrl/Cmd+A and triple-click select the current track. Default drag/Shift selection stays in the current staff/voice; the inspector explicitly broadens lanes/tracks. DOM pointer/keyboard events supply modifiers because public alphaTab beat events omit them. Inputs/selects/textareas/contenteditable keep native text shortcuts.

Use alphaTab's public `highlightPlaybackRange`/`clearPlaybackRangeHighlight` solely to draw the visible-track range, and the public highlight bounds for handles. Do not apply the highlight as a playback range or seek transport. Cross-track scope appears in track badges/inspector. Refresh model callbacks/overlays on render and dispose subscriptions on teardown. Note-only selection highlights may use owned overlays from public note bounds.

Root performs a fresh rebuild before commands consuming playbackStart/derived links, then after mutation, preserving `scoreFromJson` dynamics restoration, captured links, `copyGpInterchangeSource`, binary backing and raw lyric weak-map sources. Managed lyrics may redistribute according to the existing subsystem after notes change; exact source text/visibility/slots remain unchanged. Unmanaged imported lyric assignments outside edited notes remain on their original beats. No track/staff deletion/reordering is part of this delivery.

## Acceptance

Meaningful RED tests precede implementation. Check exact selection membership/reverse drags/grace groups, last-invalid-target atomicity, partial chords, nongreedy fingering, nonmonotonic9string tuning/capo/harmonics, boundary links, raw lyrics/controllers/backing/dynamics across rebuild/history, keyboard vs text controls and playback-loop independence. Independently decode MIDI pitches/velocities before and after note shifts/refingering. Root verifies native save/restart/undo/redo and actual rendered interactions, then requests independent review. See the plan for exact fixtures/assertions. Windows evidence alone does not establish physical macOS/Linux interaction behavior or GP8 target-runtime equivalence.
