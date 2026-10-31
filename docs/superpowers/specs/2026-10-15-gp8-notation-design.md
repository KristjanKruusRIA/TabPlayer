# Guitar Pro 8 beat and bar notation design

Date: 2026-10-15. Status: accepted subsystem design under the user's standing instruction to complete all parity changes using parallel workers; root accepted this bounded design. This refines [the umbrella parity design](2026-10-15-gp8-feature-parity-design.md). Execution follows [the notation plan](../plans/2026-10-15-gp8-notation.md).

## Outcome and scope

Author the remaining bounded public-model beat/bar gestures through native history: slap/pop/tap/dead slap/golpe, all 18 rasgueados, fades, beat vibrato, slash/barre/timer, stem/beaming, ottava spans/clefs, audible targeted crescendos, fermata symbols/stored values, similes, common/cut display, double bars, rhythmic feel, and custom beaming. Preserve the approved slate/cream/lime editor layout and existing inspector patterns.

Relevant [baseline](../../validation/2026-10-15-gp8-parity-baseline.md) rows are **T19/T22/T23/T26**, **N10/N13/N14/N16/N18/N19/N20/N24/N25/N26/N28**. Fermata timing, unknown GP styling fields, dedicated slap/pop/golpe sound, and nested tuplets remain open independently.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**, immutable source plus finite commands. Old history retains its meaning.
- Use alphaTab **1.8.4**, fflate **0.8.3**, and the existing React/TypeScript and Rust/Tauri stack; no dependency changes.
- Root owns shared TypeScript/Rust DTOs and validators, engine/router, App/EditorPanel/ScoreView, model rebuilds, GP adapter integration, selection/export integration, Git, and desktop verification.
- Feature workers edit only assigned new modules, panels, tests, and authored fixtures. Do not edit installed alphaTab or first-delivery feature files.
- DTO indices are zero-based; measure labels are one-based. Validate complete payloads and destinations before mutation. Undo/redo uses deterministic history replay.
- Standard GPIF fields must be demonstrated by public readers/writers or authored GP8 fixtures; no invented extension elements, IDs, or private properties.
- Model retention, native replay, rendered notation, musical output, and target-runtime GP8 compatibility require separate evidence.
- Fermatas cover authoring, public-model retention, proven standard GPIF fields, and native persistence first. Playback timing and Fermata.length units remain open.
- Nested tuplets N06, common/cut-time GP styling, arbitrary/final per-staff bar-line GP styling, and dedicated slap/pop/golpe sound remain separate open capabilities.

## Observed public capabilities and losses

These are narrow authored public-model probes from 2026-10-15, not product/runtime parity claims. The fixture had four 4/4 bars, four quarter notes per bar; standard-tuning string1/fret0 sounded MIDI40. Rebuild before checking derived caches. Primary manual pages for [bar symbols](https://www.guitar-pro.com/docs/gp8/score/note/symbols/bars), [notation](https://www.guitar-pro.com/docs/gp8/score/note/symbols/notation), [note symbols](https://www.guitar-pro.com/docs/gp8/score/note/symbols/note), [fades](https://www.guitar-pro.com/docs/gp8/playeffects/dynamic-tone-effects/fades), [slap/pop/golpe](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/slap-pop-golpe), and [rasgueado](https://www.guitar-pro.com/docs/gp8/playeffects/harmonics-percussive-effects/rasgueado-brush-arpeggio) are retained in the existing public manual cache.

| Probe | Observed result |
| --- | --- |
| Beat GP retention | slap/pop/tap/deadSlapped, golpe2, rasgueado18, fade3, crescendo1, ottava1, preferredBeamDirection0, beamingMode3, slashed, barreFret3/barreShape1, and showTimer survived public GP export/import. Dedicated sound is a different check. |
| Stem inversion | invertBeamDirection true became false. Public reader recognizes standard beat XProperty **1124204545**, Int1; writer omits it. Preferred directions export as standard stem-orientation fields. |
| Bar styling | Bar.clefOttava1 survived. timeSignatureCommon true became false; Bar.barLineRight7 became0. Use supported MasterBar.isDoubleBar for the double-bar workflow. Arbitrary/final per-staff bar styling remains open. |
| Custom beaming | After rebuild, 7/8 Eighth groups **[2,2,3]** roundtripped. Standard GPIF IDs are **1124139010=8**, **1124139264..266=[2,2,3]**. Stale pre-rebuild actualBeamingRules is not an exporter defect. |
| Fermata fields | Offset960/typeLong/length1.5 exported **Offset1/1** and correct stored fields. Offset87 was silently omitted by the writer's denominator search below10. Exact reduced quarter fraction is **29/320**. |
| Fermata timing | Long/length2 at tick960 left literal MIDI note ticks and tempo events identical to control. Authoring/native retention cannot close N18 playback. |
| Hairpin timing/dynamics | Four beats with crescendo1 retained literal velocities **[95,95,95,95]**. A target-dynamics operation is necessary. |
| Ottava representation | ottava1 left MIDI keys unchanged. Model notes store sounding pitch; the region adjusts standard-notation placement. Do not add a second automatic MIDI octave shift. |
| Simile | Simple at bar1 sounded bar0; double at bars2/3 sounded bars0/1. Quarter starts remained **0,960,1920,2880,...**. Native playbackBar already resolves sources. |
| Rasgueado Ii | A three-string quarter chord produced literal note-ons **(0,40),(60,45),(120,50),(480,50),(540,45),(600,40)**; next beat starts960. |
| Fades | Rebuilt FadeIn emits CC7 0->120 ending tick768; FadeOut120->0 at768; VolumeSwell reaches0 at864. These are CC7, not CC11; preserve them with track-mix automation. |
| Sound boundary | Native Articulation has no slap/pop/golpe variants and current articulation selection ignores those flags. Dedicated technique sound remains a sound delivery requirement. |

Enum values: Ottavia **15ma0,8va1,Regular2,8vb3,15mb4**; FadeType0..3; GolpeType **None0,Thumb1,Finger2**; CrescendoType0..2; BeatBeamingMode **Auto0,Split1,Merge2,SecondarySplit3**; TripletFeel0..6; BarreShape **None0,Full1,Half2**. preferredBeamDirection is **null|0|1** (up/down); **model.BeamDirection is not a runtime export**.

## Finite command surface

Root stages `src/editor/gestures-types.ts` once before parallel dispatch. Both feature workers consume it unchanged. This prevents a shared writable type file while implementing independently.

```ts
export type GesturePatch = {
  tap?:boolean; slap?:boolean; pop?:boolean; deadSlapped?:boolean;
  golpe?:number; rasgueado?:number; fade?:number; vibrato?:number;
  slashed?:boolean; showTimer?:boolean;
  barre?:{fret:number;shape:number}|null;
  stem?:'auto'|'inverted'|'up'|'down';
  beamingMode?:number;
};
export type GestureCommand =
  | {type:'setBeatGestures';target:BeatTarget;patch:GesturePatch}
  | {type:'setOttava';from:BeatTarget;to:BeatTarget;ottava:number}
  | {type:'setCrescendo';from:BeatTarget;to:BeatTarget;
     crescendo:number;targetDynamics:number|null}
  | {type:'setFermata';target:BeatTarget;fermata:{type:number;length:number}|null};
export type BarGestureCommand =
  | {type:'setBarGestures';track:number;staff:number;bar:number;clefOttava:number}
  | {type:'setMasterBarGestures';bar:number;commonTime:boolean;
     doubleBar:boolean;tripletFeel:number;beaming:{unit:number;groups:number[]}|null}
  | {type:'setSimile';track:number;staff:number;bar:number;kind:'none'|'single'|'double'};
export function applyGestureEdit(score:model.Score,command:GestureCommand):boolean;
export function applyBarGestureEdit(score:model.Score,command:BarGestureCommand):boolean;
```

The gestures worker owns new `gestures.ts`, `GesturePanel.tsx`, their tests, and `src/interchange/notation.ts` / tests/fixtures. The bar worker owns new `bar-gestures.ts`, `BarGesturePanel.tsx`, and their tests. Avoid existing techniques.ts, notation.ts, TechniquePanel.tsx, and first-delivery workers' files. Root owns shared registration/replay/native/selection/XML projection/UI integration.

Validate exact fields on both native/frontend sides. Flags must be booleans; golpe0..2, rasgueado0..18, fade0..3, vibrato0..2, beamingMode0..3, ottava/clefOttava0..4, crescendo0..2, tripletFeel0..6. barre null clears; nonnull requires integer fret **1..127**, shape **1|2**. Reject empty patches and unknown/missing required fields/nonfinite values. Rust optional nullable fields use the existing present_nullable pattern: omitted barre differs from explicit null.

Nonzero tap/slap/pop/deadSlapped/golpe/rasgueado/barre require a nonpercussion tuned staff, without restricting MIDI program. Clearing is always allowed after changing staff type. Rasgueado requires at least two distinct stringed notes. Golpe on a rest is allowed as a body-percussion gesture; audible rendering remains open. Slashed/stem/beaming/timer/fade are legal for nonempty pitched/percussion beats where the public renderer supports them. Validate before mutation; do not silently clear one guitar technique when another is set.

stem auto clears preference/inversion; inverted sets null preference and inversion true; up/down set preferred0/1 and inversion false. These are stable set operations. Imported combined preference/inversion remains unchanged until explicitly edited.

## Bounded ranges and octave representation

Ranges have inclusive existing endpoints in the same track/staff/voice, chronological order. Collect all destinations before mutation. setOttava assigns every selected Beat.ottava and preserves Note.realValue/MIDI pitch; Regular2 clears. Contiguous fields form regions without a separate region store. Clef ottava is bar-scoped and does not duplicate staff transposition/destructive pitch transposition.

## Audible targeted crescendo

Nonzero crescendo requires targetDynamics **0..7**, at least two nonrest/nonempty attacks, and a first eligible Beat.dynamics value in0..7. Crescendo target must be higher; decrescendo lower. Clearing requires crescendo0/targetDynamics null and preserves dynamics.

Fill the hairpin on every selected beat. Derive progress from first to last eligible absolute display onset and round linear interpolation of dynamic enum values. Assign each value to the beat and all its notes. Four equal P2->FF6 quarters give enums **[2,3,5,6]**, literal basic MIDI velocities **[47,63,95,111]**. Unequal rhythms use onset progress; rests carry the span without an audible step; unselected following beats remain unchanged. Preserve the first delivery's per-note dynamics rebuild fix.

This is a concrete functional stepped-dynamics policy with standard GPIF Dynamic values. GP8's exact interpolation/rounding remains a target-runtime comparison; its manual's approximate velocity table is not alphaTab's literal mapping. Do not claim finer interpolation without an authored standard-field fixture.

## Fermata authority and bounded first delivery

setFermata resolves the selected beat's current playbackStart and writes/removes one authoritative MasterBar.fermata entry. A rest is valid; an empty carrier/grace-only target is rejected. Type0..2; Length must be finite and 0 or more (Guitar Pro stores 0; decision 2026-10-21). Resolve aligned beats across tracks/staves/voices before mutation, then update all derived Beat.fermata references together. Clearing only the map allows finish() to recreate the entry from a stale beat reference.

Store the master-bar map in public-model JSON. The effect is global despite its selected-beat input. Replay evaluates the endpoint at the time of its command. Existing absolute-offset fermatas stay absolute after subsequent rhythm edits; do not shift them using guessed note identity.

This delivery covers **authoring and native persistence first**, including stored Length/type/offset and proven standard GPIF fields. The public declarations/manual do not establish Length units, and public MIDI ignores fermatas. Do not label Length seconds, implement a multiplier, change native playback timing, or add a second timeline/hold DTO. Timing remains open.

A later bounded timing design needs an authored two-track GP8 fixture: 120 and60 BPM, short/medium/long, two numeric lengths, a rest, and another track sustaining across the boundary; inspect standard GPIF Length plus literal note-off/on/tempo differences. That probe is an open evidence requirement, not new research or implementation inside this batch.

## Simile, master-bar controls, and timers

Single requires bar>=1 and matching source/destination durations. Double requires bar>=2, a following bar, and matching two-bar meter/duration pairs. Set Simple or FirstOfDouble/SecondOfDouble atomically. Replacing either half clears the old adjacent pair first; none clears a pair when selected on either half. Never delete underlying destination notes; clearing reveals them. Reject orphan halves and invalid source spans without mutation. Root verifies selected GP/MIDI export uses sounding source bars as well as public/native playback.

setMasterBarGestures replaces only its four controls. commonTime true accepts **4/4 or2/2** only; doubleBar maps to MasterBar.isDoubleBar across all staves; tripletFeel affects this master bar only. beaming null removes the explicit override, using public inheritance/defaults. Otherwise unit is **8|16|32**, groups are positive safe integers, and sum(groups) must equal integral numerator*unit/denominator. Construct one public BeamingRules.groups entry, such as 7/8 `{unit:8,groups:[2,2,3]}`. Preserve existing setMeasureSettings resetting commonTime false; old command history must not change meaning.

showTimer sets the public flag and clears stale timer. Before rendering score/PDF, root generates on a detached current model and copies timer values by stable Beat.id to the displayed model. Test note/rest first-pass times across repeats and tempo changes; null/zero cached timers are not success. Fermata-adjusted timer times stay open with fermata playback.

Barre fields form contiguous rendered full/half spans. Slash preserves note pitches/MIDI. Beat vibrato uses public generation. Wah/sustain pedals, courtesy accidentals/string numbers, multirests, arbitrary/final per-staff bar styles, and nested tuplet groups remain separate note/layout/sound work.

## Panel and proven GPIF adapter interfaces

```ts
export interface GesturePanelProps {
  score:model.Score; target:BeatTarget; busy:boolean;
  onEdit:(command:GestureCommand)=>void;
}
export function GesturePanel(props:GesturePanelProps):React.JSX.Element;
export interface BarGesturePanelProps {
  score:model.Score; track:number; staff:number; bar:number; busy:boolean;
  onEdit:(command:BarGestureCommand)=>void;
}
export function BarGesturePanel(props:BarGesturePanelProps):React.JSX.Element;
export function writeGpifNotation(score:model.Score,doc:Document):void;
```

Use existing details/fieldset controls with named choices. GesturePanel has selected-beat flags, golpe/rasgueado/fade/vibrato, stem/beam, slash/barre/timer, small same-voice range forms for ottava/crescendo, and a clearly global fermata form. BarGesturePanel has clef ottava, simile, common/cut display, double bar, feel, and group input. Reset on selection/score change and disable busy; one action creates one history entry.

writeGpifNotation maps generated Beat IDs to model Beat.id. Add/update standard inversion XProperty **1124204545/Int1**; remove that property when false. Replace only the generated MasterBar Fermatas subtree with all authoritative offsets reduced from offset/960, including **87->29/320**, **0->0/1**, **960->1/1**. Preserve unrelated XML, source objects/bytes, siblings, and current DSP/percussion patches. Root owns any required beat/master-bar projections alongside its existing track projection.

Do not adapt already retained fields or invent common/cut/final-line styling elements. Public GPIF currently handles numeric Time only. Native/PDF styling can work while GP fidelity stays open pending an authored GP8 field; private extensions cannot close it.

## Acceptance and self-review

Require finite atomic commands, deterministic replay/save/reopen, unchanged neighbors/voices/pitches/links, clear paths, sounding similes, audible dynamic progression, and retained fermata fields. GP evidence includes independent XML and literal SMF checks where musical behavior exists. Root visually verifies glyphs, spans, beams, octave clefs, similes, timers, and exported PDF/GP.

- Every proposed control uses known native/public fields; only proven standard GPIF omissions receive repairs.
- Fermatas are authoring/persistence only in this batch; no placeholder timing conversion is introduced.
- Gestures/bar workers have no shared writable files after root stages types.
- The plan covers set/clear/invalid/replay/export/render cases. Dedicated sounds, exact GP8 interpolation, unknown styling, and nested tuplets remain independently open.
