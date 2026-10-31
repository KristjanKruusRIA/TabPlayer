# Guitar Pro 8 harmony tools design

Date: 2026-10-15. Accepted bounded subsystem under the user's standing approval to complete the full parity goal using parallel workers. This extends the [umbrella design](2026-10-15-gp8-feature-parity-design.md), delivered entry/lyrics/range reports and the stable range/fingering APIs. Execute with [the harmony plan](../plans/2026-10-15-gp8-harmony.md).

## Outcome, requirements and evidence

Build useful chord construction/recognition/alternative shapes, personal chord storage, a scale browser/selection matcher, and chromatic/diatonic transposition. The approved score layout and physical instrument art stay in place. Chord/scale tools occupy an inspector dialog.

| Inventory | This delivery | Explicit remaining boundary |
| --- | --- | --- |
| U01 | Open/mute/fret diagrams, barres, explicit finger data, name/diagram/fingering flags, native retention | Public score renderer does not display arbitrary chord finger numbers; above-staff engraving/print requires later owned rendering. |
| U02/U03 | Structured formulas, alterations/omissions/bass, generated shapes and exact-set recognition | Search is bounded, ambiguous recognition remains a list; GP8's proprietary optimizer is not reproduced. |
| U04 | Persistent personal library and track chord list | Actual track-sound audition needs a separate bounded native preview workflow; no existing public audition API is available. |
| U05 | No new scale-diagram authoring in this delivery | Public model/GPIF scale schema and above-beat engraving are unestablished. Keep the entire row open for dedicated source/runtime research. |
| U06/U07 | Sixteen named scale patterns, all twelve roots, interval display, custom interval exploration and ranked selection matches | Do not call 192 root/pattern combinations 1,000 distinct scales. Full catalog, audition, score-bound diagrams and physical-view overlays remain open. |
| U08/U09/U10 | Chromatic interval UI; diatonic in-key note shifts; optional whole-bar/all-track key updates; native structured-chord transpose | Out-of-key diatonic notes, theoretical GPIF roundtrip, imported manual-name chord inference, complex harmonic conversion and exact enharmonic engraving remain explicit limits. |
| E13/S19/S21/U12–U15 | Consume delivered note-shift/fingering foundation | Retune/capo refingering, concert-pitch mode and physical-view input/options are separate inventory items. |

Primary requirement sources: [chords](https://www.guitar-pro.com/docs/gp8/tools/chords-diagrams), [scales](https://www.guitar-pro.com/docs/gp8/tools/scales), [scale diagrams](https://www.guitar-pro.com/docs/gp8/tools/scales-diagrams), [transpose](https://www.guitar-pro.com/docs/gp8/tools/tools-transposition). Cached bodies are in `.analysis/parity/public-manual-pages.json`. They establish the documented controls and workflows; the policies below are app decisions where vendor behavior is unspecified. The [official scale-tool article](https://www.guitar-pro.com/blog/p/45050-level-up-your-playing-with-the-guitar-pro-scales-tool) separately demonstrates selection analysis, interval viewing and audition. Interval collections are independently described by [Open Music Theory](https://viva.pressbooks.pub/openmusictheory/chapter/collections/) and [its original collection reference](https://openmusictheory.github.io/atonal.html); tables below are explicit mathematical data, not a copied vendor catalog.

Current source evidence: model.Chord exposes name, firstFret, strings, barreFrets and showName/showDiagram/showFingering, but no explicit per-string fingers/theory; no public ScaleDiagram model exists. Current setBeatAnnotation recreates a simple Chord while editing text, so the new text-only command below avoids erasing rich data. Existing range code already transposes notes atomically and preserves dynamics/links. The renderer/PcmWriter offers offline primitives, but a user-facing audition workflow requires new IPC/async/lifetime work and is a separate follow-up.

A read-only authored in-memory public GP probe on 2026-10-15 exported/reopened Cm at firstFret3, strings `[3,4,5,5,3,-1]`, barreFrets `[3]`, flags false/true/false unchanged. Its standard Diagram fields include baseFret2, reversed zero-based Fret.string, Fingering/Position, and the three display properties. Public writer nevertheless emits a **C-major theoretical Chord child for Cm**. Thus chord names/shapes are proven; the theoretical subtree is not reliable. Public writer emits `Ring` while its reader recognizes `Rank` for that finger; the owned adapter accepts both demonstrated spellings. No target binary session or original-GP8 runtime was used for this probe.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Existing command histories retain their meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3** and the existing Rust/Tauri/React stack; no new product dependencies or proprietary catalogs/assets.
- Root owns shared DTOs, validators, engine/range helpers, App/EditorPanel/ScoreView, playback/export/clipboard integration, Git, builds/apps and native verification. Workers own isolated new modules/tests only.
- Validate all notes/chords/key destinations before mutation; each document edit is one history entry. Browse/recognize/library management does not dirty the score.
- Preserve per-note dynamics, valid links, raw lyric sources, backing bytes/anchors, GP archive siblings, settings replay and unselected music through every clone/rebuild/export.
- Standard GPIF output uses demonstrated public/native fields only. Native metadata retention, public GP roundtrip, actual MIDI/audio and original-GP8 acceptance are separate claims.
- Keep the approved slate/cream/lime layout, note-name pitch displays and one-based user labels. Unsupported musical/contextual inputs reject visibly rather than losing data.

## Exact shared types and commands

Root stages `src/editor/harmony-types.ts` with type imports for existing BeatTarget, IndexedNoteTarget, MusicSelection and model. Export these definitions:

```ts
interface SpelledPitchClass {step:number;alteration:number} // C,D,E,F,G,A,B = 0..6; -2..2
type ChordDegree = 1|2|3|4|5|6|7|9|11|13;
type ChordFormulaId = 'major'|'minor'|'dim'|'aug'|'sus2'|'sus4'|'power'|
  '6'|'m6'|'7'|'maj7'|'m7'|'mMaj7'|'m7b5'|'dim7'|'9'|'maj9'|'m9'|'11'|'m11'|'13'|'7sus4';
interface ChordRecipe {
  root:SpelledPitchClass;formula:ChordFormulaId;
  alterations:Array<{degree:5|9|11|13;shift:-1|1}>;
  omissions:ChordDegree[];bass:SpelledPitchClass|null;
}
interface HarmonyChord {
  name:string;nameMode:'manual'|'theory';recipe:ChordRecipe|null;
  firstFret:number;frets:number[];fingers:number[];barreFrets:number[];
  showName:boolean;showDiagram:boolean;showFingering:boolean;
}
type HarmonyInterval =
  | {kind:'semitones';semitones:number}
  | {kind:'chromatic';number:number;quality:'perfect'|'major'|'minor'|'augmented'|'diminished';direction:'up'|'down';octaves:number}
  | {kind:'diatonic';steps:number};
type HarmonyCommand =
  | {type:'setBeatText';target:BeatTarget;text:string}
  | {type:'setHarmonyChord';target:BeatTarget;chord:HarmonyChord|null;fillEmptyBeat:boolean}
  | {type:'transposeHarmony';selection:MusicSelection;interval:HarmonyInterval;includeKeySignatures:boolean;includeChords:boolean};
interface PitchTarget {address:IndexedNoteTarget;pitch:number} // target sounding MIDI pitch
interface ChordShapeSearch {maxFret:number;maxSpan:number;limit:number}
interface ChordMatch {recipe:ChordRecipe;name:string;bass:number;pitchClasses:number[]}
interface ScalePattern {id:string;name:string;intervals:number[];tags:string[]}
interface ScaleMatch {patternId:string;root:number;matched:number;total:number;extra:number}
interface HarmonyLibraryEntry {id:string;label:string;chord:HarmonyChord;tuning:number[];capo:number;transposition:number}
interface HarmonyLibrary {format:'TabPlayerHarmonyLibrary';version:1;entries:HarmonyLibraryEntry[]}
interface HarmonyChordDialogProps {
  score:model.Score;target:BeatTarget;selection:MusicSelection|null;value:HarmonyChord|null;
  busy:boolean;library:HarmonyLibrary;onEdit:(command:HarmonyCommand)=>void;onClose:()=>void;
  onLibraryPut:(entry:HarmonyLibraryEntry)=>Promise<void>;
  onLibraryRemove:(id:string)=>Promise<void>;
}
interface ScaleToolPanelProps {score:model.Score;staff?:model.Staff;selection:MusicSelection|null;busy:boolean;onClose:()=>void}
interface ChordDiagramPreviewProps {
  chord:HarmonyChord;staff:model.Staff;highlightRoot:boolean;
  onToggle:((stringIndex:number,fret:number)=>void)|null;
}
```

Exact new envelopes/nested objects reject unknown fields. Indices are integers0..u32::MAX. The preserved-source/native snapshot domain accepts firstFret0..127, frets-1..127, fingers-2..4 (`-2` unknown, `-1` no/dead, `0` thumb), and equal fret/finger lengths0..12. Barre entries are integers0..127; preserve imported order/duplicates. Any combination of the three boolean display flags, including all false, is valid. Manual mode has recipe:null and preserves name exactly. Do not impose a five-fret viewport or new physical-fingering test on passive copies/manual legacy definitions: valid existing firstFret0, wide-spread and hidden diagrams must stay editable/copyable without normalization. Zero-string manual name-only chords on untuned staves are valid. Applying an edited manual definition requires its string count to match the destination staff, including zero; new UI defaults firstFret1 and clears a newly toggled open/muted string's finger to Unknown without rewriting unchanged imported data.

Theory mode requires a valid recipe and name exactly formatChordName(recipe). A played theory-mode shape must contain exactly its required sounding tone set and explicit bass on a tuned melodic staff; a name-only all-muted definition is allowed. Generated shapes use firstFret at least1 and the bounded five-fret-or-smaller search viewport below; this search restriction is not a global snapshot restriction. Generated/edited suggestions use unique positive compatible barres, while unchanged source data remains passively preservable. A manual fret edit that breaks the formula switches to manual mode unless the user chooses a newly recognized recipe. Manual names are never inferred automatically for transpose. A leading ASCII/curly apostrophe in the UI selects manual mode and is not part of the displayed name; the finite DTO stores explicit mode.

Chromatic numbers1..7, octaves0..9; base major/perfect semitones `[0,2,4,5,7,9,11]`. Perfect is allowed on1/4/5; major/minor on2/3/6/7; augmented adds1; diminished subtracts1 from a perfect class or2 from a major class. Diminished unison is rejected. Direction applies to the entire interval. Final nonzero semitones must be -127..127. Semitone mode excludes0 with the same range. Diatonic steps are signed -70..70 excluding0; UI interval3 upward means steps2. Diatonic disallows both include flags in this delivery. Key updates require a complete-bar selection covering every track; chord updates require whole selected beats, not a subset of one chord's notes.

## Pure chord and scale theory

`src/harmony/chords.ts` exports `chordTones(recipe:ChordRecipe):Array<{degree:ChordDegree;pitchClass:number}>`, `formatChordName(recipe):string`, `recognizeChords(pitches:readonly number[],preferredRoot:SpelledPitchClass|null):ChordMatch[]`, and `findChordShapes(staff:model.Staff,recipe:ChordRecipe,search:ChordShapeSearch):HarmonyChord[]`.

Degree semitones relative to the root: 1=0,2=2,3=4,4=5,5=7,6=9,7=11,9=14,11=17,13=21. Formula tone lists are: major1/3/5; minor1/b3/5; dim1/b3/b5; aug1/3/#5; sus2=1/2/5; sus4=1/4/5; power1/5; 6=1/3/5/6; m6=1/b3/5/6; 7=1/3/5/b7; maj7=1/3/5/7; m7=1/b3/5/b7; mMaj7=1/b3/5/7; m7b5=1/b3/b5/b7; dim7=1/b3/b5/bb7; 9/maj9/m9 add9 to their seventh formula; 11/m11 add9/11; 13 adds9/11/13 to dominant7; 7sus4=1/4/5/b7. Deduplicate resulting pitch classes.

Alteration sets the named degree to its major-degree base plus shift; it may add an absent9/11/13. Reject altering a degree already altered by the base formula to avoid contradictory names. Omissions remove degrees; reject duplicates, absent omissions and an empty result. Bass may be any spelled pitch class; chordTones returns formula degrees only, while shape validation unions an outside bass as a separate required tone. Null bass permits any inversion. Names use root + formula suffix (major has none, minor `m`, power `5`) + `(b5,#9,no3,...)` modifiers in degree order + optional `/bass`; examples `C`, `Cm7`, `Cmaj9`, `C7(b9,no5)/E`. Root spelling is preserved, not rewritten from a MIDI number.

Chord analysis and shape generation use **sounding** pitch classes, including capo/sounding transposition. Label that context in the tool. Recognition considers exact pitch-class sets of the22 base formulas in all roots; bass is the minimum input pitch. Rank preferred root first, then root-in-bass, fewer tones, formula order/root number. Return alternatives for ambiguity; a two-note power chord may match, an incomplete arbitrary triad need not receive a definitive name. Percussion/dead notes are excluded by the selection adapter; ghost notes and tied written pitches still contribute their pitch class.

Shape search covers frets0..maxFret with maxFret1..127, maxSpan0..4, limit1..12 (UI24/4/12). One fret/mute per string, every required pitch class present, no foreign tones, explicit bass lowest when given. Use detached model pitch getters and current tuning, never reverse strings by visual assumption: diagram frets array is high-to-low; model string is `count-index`. Search each five-fret-or-smaller window with a beam of at most256 partial shapes per string, pruning impossible tone coverage. Stable rank is muted count, positive-fret span, maximum fret, fret sum, then lexicographic high-to-low fret vector. Deduplicate across windows, return the first limit. This is a bounded useful search, not an exhaustive impossibility proof; report "No shape found in this search window" when empty.

Generated fingering uses a conservative compatible-span rule. Group positions at one positive fret; a shared-finger barre is suggested only when every intervening string from the group's first to last position is played at that fret or higher. An open, muted or lower-fret intervening string blocks the barre. A compatible repeated group consumes one finger; otherwise each positive position in that group consumes a separate finger. Assign fingers1..4 by ascending fret then high-to-low string, and discard generated candidates needing more than four units. Do not infer playability from distinct-fret count alone or add an automatic thumb heuristic. Literal Fdim7 `[1,0,1,0,-1,-1]` has the correct F/B/Ab/D pitch classes but must use separate fingers for its two fret1 positions: a barre would fret the intervening open B. Manual thumb/finger choices remain available. Independent pitch-set and compatible-span checks must validate every generated result.

`src/harmony/scales.ts` exports `scalePatterns:readonly ScalePattern[]`, `scalePitches(root:number,intervals:readonly number[],octave:number):number[]`, and `matchScales(pitches:readonly number[],patterns?:readonly ScalePattern[]):ScaleMatch[]`. Root0..11, octave0..9; pitches are `12*octave+root+interval`, followed by the upper tonic at+12, with every final pitch0..127. Custom intervals are sorted unique0..11 including0, minimum2notes. No new score edit is emitted by browsing/searching.

| Pattern | Semitones from root |
| --- | --- |
| Major/Ionian | 0,2,4,5,7,9,11 |
| Dorian | 0,2,3,5,7,9,10 |
| Phrygian | 0,1,3,5,7,8,10 |
| Lydian | 0,2,4,6,7,9,11 |
| Mixolydian | 0,2,4,5,7,9,10 |
| Natural minor/Aeolian | 0,2,3,5,7,8,10 |
| Locrian | 0,1,3,5,6,8,10 |
| Harmonic minor | 0,2,3,5,7,8,11 |
| Melodic minor, ascending | 0,2,3,5,7,9,11 |
| Major pentatonic | 0,2,4,7,9 |
| Minor pentatonic | 0,3,5,7,10 |
| Minor blues | 0,3,5,6,7,10 |
| Whole tone | 0,2,4,6,8,10 |
| Chromatic | 0,1,2,3,4,5,6,7,8,9,10,11 |
| Octatonic half-whole | 0,1,3,4,6,7,9,10 |
| Octatonic whole-half | 0,2,3,5,6,8,9,11 |

Search names/tags case-insensitively; major/Ionian and minor/Aeolian are aliases, not extra scales. Display note names, adjacent semitone intervals including octave wrap, and degrees. Selection matching uses distinct sounding pitch classes: matched/total selected classes, then fewer extra scale tones, stable catalog/root order. Empty/all-percussion selection produces no matches. This explicit ranking is not claimed to reproduce GP8's undocumented occurrence weighting.

## Native chord/source retention

`src/harmony/chord-source.ts` keeps a WeakMap<model.Chord,HarmonyChord> and exports `getHarmonyChord(chord:model.Chord):HarmonyChord`, `setHarmonyChordSource(chord:model.Chord,value:HarmonyChord):void`, `copyHarmonySources(sourceScore:model.Score,destinationScore:model.Score):void`, and `copyHarmonyChord(sourceChord:model.Chord,destinationChord:model.Chord):void`. Get merges live public shape/name/flags with owned fingers, returning a deep snapshot. Without owned metadata it returns manual mode with unknown fingers. If an owned played theory shape no longer matches its recipe in chord.staff's current tuning/capo/sounding offset, the returned snapshot uses nameMode:'manual',recipe:null and the exact current name/frets/fingers/flags. This read is pure: retain authored recipe provenance in the WeakMap and native history, perform no refingering/relabeling, and permit Undo of the context edit to recover the valid theory snapshot. An untuned/incompatible staff with a played theory shape follows the same downgrade; a name-only all-muted recipe has no played shape to contradict it. Dialog/library/clipboard consume this valid effective snapshot rather than serializing stale theory mode.

Copy by current track/staff/chordId immediately after full model clones, before removing/reordering tracks. Explicit clone-to-new-ID callers use copyHarmonyChord. Both copy helpers copy owned provenance directly, not the context-downgraded getter result, then subsequent get evaluates destination context. Legacy manual firstFret0/wide/hidden/zero-string data is not normalized or rejected in passive copies. Native history contains complete authored definitions, so rebuild/save/restart is deterministic and existing retune/capo command meaning stays unchanged while S19 remains open.

`src/harmony/edits.ts` exports `applyHarmonyEdit(score,command,editIndex):boolean` for setBeatText/setHarmonyChord. Text-only changes never recreate a chord. Chord assignment creates a unique `harmony/<editIndex>/<track>/<staff>/<bar>/<voice>/<beat>` chord ID, leaving other beats referencing an older shared definition untouched. Annotation-only changes keep beat notes/rhythm/dynamics/text. With fillEmptyBeat true and showDiagram true, an existing rest/empty beat receives the diagram's playable notes; otherwise its existing notes remain unchanged. Validate staff/string/pitch/capacity first, preserve duration, and use diagram-to-model string mapping above. Removing a chord clears only its beat reference, not music/text or other definitions. Empty-carrier entry uses its existing rhythm unless a nonpositive/unusable duration requires explicit user rhythm entry first.

`src/interchange/harmony.ts` exports `readGpifHarmony(score,doc):void` and `writeGpifHarmony(score,doc):void`, consuming the existing bounded Tracks projection. Read/write demonstrated DiagramCollection and DiagramWorkingSet string/fret/display fields plus Fingering/Position finger/fret/string. Accept `Ring` and `Rank`; write public writer's `Ring`. Explicit finger metadata is recovered by the owned reader instead of discarded by public parsing. Preserve barres and existing imported definitions. Do not invent GPIF theory/scale fields or claim the public C-major placeholder represents a new recipe; complete theoretical metadata and original-GP8 acceptance remain open. GP roundtrip tests separately prove name/shape/finger/display and expose recipe loss as a documented limitation.

Root extends copyGpInterchangeSource to call copyHarmonySources, maintaining its existing lyrics/backing/archive behavior. Cover score rebuild, export selections/staff/track reorder, pitched export normalization, PDF dialog snapshots, copyVoice and clipboard chord clones. For native clipboard preservation, add a **version2** MusicClip variant with all v1 fields plus `harmony:Array<{track:number;staff:number;chordId:string;chord:HarmonyChord}>`; v1 remains accepted unchanged. V2 records contain only referenced chords with owned extra metadata, using getHarmonyChord's effective snapshot; legacy definitions without owned extras remain in public scoreJson without a redundant rich record. Validate matching public shape/name/flags against the permissive snapshot domain above, including firstFret0/wide/hidden/zero-string manual values.

For v2 rich-record diagram paste with diagrams=true, require identical source/destination tuning arrays, capo, sounding transposition and string count before installation. A manual zero-string name-only record may transfer between matching untuned contexts; a played diagram requires a tuned melodic destination. Reject incompatible v2 rich diagrams before any mutation, including guitar-to-piano or changed tuning/capo/offset; do not reparent a saved recipe onto an incompatible shape. The user can uncheck diagrams and use the existing note conversion without copying rich records. Matching-context v2 paste preserves exact effective recipe/fingers and maps fresh chord IDs. V1 persisted meaning remains unchanged, and v2 public-only legacy chords without rich records retain that existing path. Root updates source/paste readers and fresh chord-ID mapping accordingly. No raw lyrics/audio/archive provenance is added to clipboard.

## Transposition and range integration

Root adds one narrow reusable export to existing range-edits.ts: `applyPitchTargets(score:model.Score,targets:PitchTarget[]):void`. It reuses existing all-proposals-first collision/fingering/link policy for simultaneous **different** note deltas; do not loop single-note transpose commands, which can falsely collide with yet-unmoved chord members. Targets are unique existing melodic notes, sounding pitch0..127; the low-level helper still rejects percussion targets. Pitched written pitch is target+staff.transpositionPitch; stringed candidates use existing planFingering with unselected notes fixed. Shift trill absolute values by each note's delta; preserve dynamics, bend intervals and IDs; clear forced accidental to Default. Internal ties must remain equal, boundary ties detach without moving unselected notes, and string-only links follow current range invariants. Reject harmonics/continued bends that cannot preserve exact intended pitch rather than approximating them.

Preserve the current captureNoteLinks representation of duplicate incoming ties: several destination notes in one next attack beat can share an origin while only one is its canonical tieDestination. A tie's next-note invariant is membership in that next matching attack beat, not object equality with the first matching note. Fully selected pre-existing equal duplicate ties remain valid and keep their canonical pointer; do not treat an unchanged duplicate group as a newly introduced collision. Detaching a boundary edge clears only that destination's incoming flags. Leave a surviving canonical pointer unchanged when another sibling detaches; if the canonical destination detaches, promote a surviving sibling in source order. Validate these cases in the new helper before reusing range relationship checks. Do not change another worker's links module during parallel implementation.

`src/harmony/transpose.ts` exports `prepareHarmonyTranspose(score,command,editIndex):model.Score`. It clones immutably, immediately carries destination source/links, plans all notes/chords/keys before mutation, then uses applyPitchTargets once and returns the candidate for root's normal rebuild. The harmony adapter skips percussion notes/staves for every interval mode and preserves all drum pitches/articulations/rhythm/keys/links unchanged. Thus a normal all-track guitar/piano/drum bar selection can update melodic notes/keys without passing drums into the pitched-only helper. If no melodic note/chord/key destination would change, reject as a no-op. This adapter policy does not change delivered RangeCommand's percussion rejection. No settings edit/bar mapping occurs; existing settings-only replay must produce the same effective settings.

Chromatic modes use uniform semitone shifts. Interval-quality UI resolves the exact DTO formula above; chord root/bass spelling can follow its diatonic letter displacement, rejecting spellings beyond double accidentals. Semitone mode picks sharps for nonnegative destination key signatures, flats for negative; score note engraving otherwise uses public automatic spelling, with explicit glyph acceptance still required.

Diatonic uses each note's **written** major/natural-minor bar key, not the sounding-analysis context. Fifth count k gives major tonic `(7*k) mod12`, minor tonic major+9; mode intervals follow the table. Determine its scale degree and octave, shift by signed steps and convert back to sounding pitch through the staff offset. Reject an out-of-key written pitch in this first version; no hidden chromatic alteration policy. Example C-major written C4/E4/G4 with steps2 becomes E4/G4/B4, literal64/67/71 without offset. Different per-note deltas are committed simultaneously. Key changes inside selection are applied per source bar; tied notes mapped to unequal pitches reject.

IncludeKeySignatures requires complete selected bars/all tracks, including any drums in the selection scope, and a chromatic mode. Update melodic staff keys only; keep percussion staff keys unchanged. Preserve major/minor mode; choose the target tonic's available -7..7 signature. Chromatic interval spelling determines the target key name where representable; semitone mode chooses fewest absolute fifths, then source sign. Reject unrepresentable key names. IncludeChords transposes only effective theory-mode recipes at selected complete melodic beats; clone a shared chord definition for selected references so unselected occurrences stay exact. Manual-name and context-downgraded chords stay unchanged and the UI reports their skipped count. Preserve formula/alterations/omissions and shift root/bass; prefer the old shape shifted on its strings, otherwise use the bounded shape search. Validate exact resulting tone set/bass before commit. Missing valid shape rejects the whole operation. Diatonic chord/key transpose is explicitly unsupported here.

## Library and view

New Rust `src-tauri/src/harmony_library.rs` validates/persists HarmonyLibrary atomically as `harmony-library.json` under existing app-data directory. Tauri commands `harmony_library_read`, `harmony_library_put {entry}`, `harmony_library_remove {id}` manage unique UUID records; label is nonempty up to200Unicode scalar values, no path argument. Entry tuning has length0..12 with integer pitches0..127, capo is integer0..127 and transposition integer-127..127; the zero-string context is permitted for preserved manual name-only definitions. Put replaces the same UUID atomically; read rejects duplicate UUID records. Use the same permissive chord snapshot domain as getHarmonyChord/clipboard so saving a legacy firstFret0/wide/hidden manual snapshot works. A corrupt file returns an error without replacement. These are user-library actions, not Project edits. Existing staff.chords supplies the current-track library. Save uses the current effective snapshot; direct fret recall requires matching context, otherwise a valid theory recipe can generate a new shape for the destination. Manual incompatible shapes reject until the user deliberately edits them. New/Open does not clear personal storage.

New worker components `HarmonyChordDialog.tsx`, `ScaleToolPanel.tsx` and small owned `ChordDiagramPreview.tsx` consume the exact props above and follow current modal/focus/fieldset patterns. Preview reads its staff without mutating it to derive sounding tone names/root highlights from actual tuning/capo/sounding offset; it never assumes standard guitar tuning. Preview stringIndex is the high-to-low array index; fret-1/0 means mute/open and positive values are absolute frets. Expose explicit root/formula/alterations/omissions/bass, selectable alternative shape, open/mute/fret/finger/barre/display controls, recognized candidates and Apply/Remove/Library. Show exact sounding tone names. Scale tool has root/pattern/search/tags/custom intervals, note/interval list, selected-passage matches and owned fretboard/keyboard preview; it emits no automatic scale-insertion edit. Root passes state/callbacks and wires the library service. There is no audition API or live-audio change in this slice. Audition through the selected track sound, score-bound scale authoring, above-staff explicit fingers, stylesheet notation variants and physical instrument overlay editing remain separate work.

## Acceptance and unresolved evidence

RED tests pin formulas/names/bass/omissions, custom/nonmonotonic1..12string voicings, ambiguous recognition, all16scale patterns/roots, interval arithmetic, simultaneous diatonic chord movement, key/bar scope, shared manual/theory chord identity, imported finger aliases, clipboardv1/v2 and source lifetimes. Independently decoded SMF must prove pitches/velocities; exported GP must reopen actual names/shapes/fingers/flags and unmodified backing/siblings. Native desktop verifies generated shape application, empty-beat fill, theory/manual transpose, library across New/Open/process restart, scale matching and native save/reopen. Final reports retain open U05/catalog/audition/engraving/GP-theory/runtime gaps; passing internal theory functions alone is insufficient.
