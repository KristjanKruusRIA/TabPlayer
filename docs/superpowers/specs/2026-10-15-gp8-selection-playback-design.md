# Guitar Pro 8 cursor and selected-passage playback

Date: 2026-10-15. Status: approved for execution under the user's standing approval; this written design and its [implementation plan](../plans/2026-10-15-gp8-selection-playback.md) are the next bounded delivery after engraving/harmony. Refines the [umbrella design](2026-10-15-gp8-feature-parity-design.md) and [practice design](2026-10-15-gp8-practice-design.md). The historical 258-row baseline is unchanged.

## Outcome and boundary

Advance **P02** (play from cursor/selection) and **P03** (partial-bar passage looping): resolve canonical score positions into actual performed occurrences, start atomically, and stop a selected one-shot at its exclusive native endpoint. Retain existing whole-measure transport, pause/resume, fixed/relative/progressive practice, count-in, backing and instrument views. Editing a selection alone never moves playback or creates a loop.

Selected playback is a **time passage of the existing complete mix**. Selecting a note chooses its beat's time, including unrelated notes/tracks sounding in that interval; it does not solo a note, voice or selected track. Sparse notes use the displayed bounding passage. Users retain mute/solo for isolation. Step audition/note-entry preview (E17), complete shortcuts (W19), instrument-view authoring/stopped modes (U12–U15), backing pitch/filter tools and new engraving/harmony features are outside this batch. P20 receives backing/practice regression evidence, not closure.

The cached official playback guide documents cursor-start, selected-section looping and separate step playback: `https://www.guitar-pro.com/docs/gp8/audio/playback/play`, local `.analysis/parity/public-manual-pages.json`. No new web retrieval or GP8 target-runtime comparison was performed for this design. The explicit grace/interior-point/occurrence policies below are application policies pending target comparison; they are not inferred GP8 equivalence.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**; selections, performed maps and playback spans never enter document history, GPIF, MIDI or saved score JSON.
- Use alphaTab **1.8.4**, fflate **0.8.3**, Rust **1.88** and the existing React/TypeScript/Tauri audio stack; no dependency changes or dependency patches.
- The native output callback is the only transport clock; no browser timers, second audio clock, status-poll stopping or temporary repeating-loop workaround.
- Root owns shared contracts, plan/renderer/device/runtime/controller integration, App/Transport/ScoreView, Git, apps/builds and acceptance. Workers edit only their assigned files after contract staging.
- Preserve source/archive/backing bytes, canonical score/links/lyrics/dynamics, authored tempo maps, existing mix/practice behavior and the approved three-column editor/instrument visuals.
- Validate complete requests before mutation/enqueue and again at the callback boundary; retain generation guards, callback epochs, coherent snapshots and allocation-free rendering/transitions.
- Wire positions are zero-based; user measure/beat/occurrence labels are one-based. A selected passage is half-open `[startTick,endTick)`.
- Model/DTO retention, actual native PCM, native history/reopen, original GP8 behavior and physical cross-platform input/audio remain separate acceptance checks; this batch cannot establish full parity.

## Approaches and selected architecture

1. **Selected:** add a small public-lookup performed map to the existing transient plan, pure selection resolution, and one atomic callback-owned start command. The renderer gets a strict event ceiling for bounded output. Existing loop/practice architecture remains in place.
2. Derive boundaries from PlanNotes or model `playbackStart`: rejected. Silent beats and tied destinations can have no attacks; trills/brushes have several; swing lookup timing differs from model playbackStart.
3. A second isolated selection renderer or frontend seek→play→poll-stop sequence: rejected. It duplicates state/resources or creates ordering races, a second clock, and incorrect trainer/count-in behavior.

No replacement editor, transport framework, selection persistence, resource cache or renderer fork is introduced.

## Pinned public evidence

An ignored original probe, `.analysis/parity/selection-playback-probe.mjs`, generates authored public models and records `.analysis/parity/selection-playback-probe.json`. Only documented/public fields and methods are called. It is a design probe, not production implementation or visual/PCM acceptance.

Public declarations: `MidiFileGenerator.tickLookup`, `MidiTickLookup.masterBars`, `getRelativeBeatPlaybackRange(beat)`, `MasterBarTickLookup.firstBeat/nextMasterBar`, `BeatTickLookup.start/end/nextBeat/highlightedBeats`, `BeatTickLookupItem.beat/playbackStart`, `Beat.displayStart/displayDuration`, `GraceGroup.beats`, `Bar.simileMark`. In the pinned declarations they are at `alphaTab.d.ts:5376–5450,8676–8718,10950–11017,11480–11561`.

| Authored probe | Observed public result | Consequence |
| --- | --- | --- |
| Rest + tie destination | Both have their own `[960,1920)` / `[1920,2880)` beat ranges although the tie destination has no independent attack | Map beats, not sounding attacks. |
| Triplet8th, all rests | Display starts0/480; public performed pair `[0,640)`, `[640,960)`; model playbackStart remains0/480 | Use generated lookup ranges for feel. |
| BeforeBeat at score start | Relative grace `[-120,0)`, principal `[0,960)`; handler tickShift120; measure starts120 | Keep handler shift once; normal principal lead-in can be0 before its measure start120. |
| BeforeBeat at next bar | Grace absolute `[3720,3840)` belongs to next bar; preceding same-voice beat ends3720; another voice can continue to3840 | A lookup slice can highlight a beat owned by the next performed measure. Preserve lane identity. |
| OnBeat / BendGrace | OnBeat grace `[0,120)`, principal `[120,960)`; BendGrace `[0,480)`, principal `[480,960)` | Grace is not an extra written-duration beat. |
| Simile simple/double | Only the **played** placeholder beat0 has range `[0,3840)`; hidden borrowed beats1+ have no played-bar lookup rows | Do not invent hidden selectable simile beats. |
| Simile borrowing BeforeBeat source | With global shift120, played placeholder starts3960; borrowed grace actually sounds3840–3960 | Placeholder-only cursor start uses3960. This intentionally cannot recover that preceding borrowed grace from a hidden source attack. |
| Pickup | One quarter pickup is `[0,960)`, next measure begins960 | Do not use written4/4 duration to place occurrences. |
| Underfull free time | Two written quarters have beat ranges to1920, but public masterbar still ends3840 | Preserve actual public timeline and silent tail; do not shorten the bar by summed attacks/beats. |
| Empty bar | Voice0 has ranges, unused empty voice1 has none. A single empty quarter placeholder can cover the full public3840-tick bar while displayDuration is960 | Presence is decided by lookup, not `isEmpty` alone. Whole-bar placeholder uses full measure written span. |
| Repeat endings / D.C. al Fine | Performed bars `[0,1,0,2]` / `[0,1,2,3,0,1]` | Use actual performed order; do not reconstruct an itinerary from lexical bar numbers. |
| One-bar repeat with leading BeforeBeat | Owning measure starts120/3960; grace groups sound0–120 and3840–3960, with both source bar indices0 | A moved grace must be assigned to the next occurrence even when adjacent written bar indices are equal. |

Read-only source inspection explains the boundaries: public generation adds rests/ties to lookup, caches only the first relative range per beat ID, relocates negative grace slices into the previous lookup, and emits a full-bar simile placeholder. Therefore occurrence-specific **slice data**, rather than treating the first cached relative range as every occurrence's authority, supplies the production map.

## Exact staged contracts

Root stages `src/audio/selection-playback-types.ts` and the matching Rust declarations before delegation. All fields below are exact. Reuse the existing `BeatTarget` with u32 track/staff/bar/voice/beat; do not duplicate it.

```ts
export interface PerformedBeat {
  target: BeatTarget;
  occurrence: number;        // ordinal for target.bar, as in plan.occurrences
  startTick: number;         // this beat's public performed range
  endTick: number;
  leadInTick: number;        // attached mapped grace-group start, otherwise startTick
}
export interface PlaybackSpan {startTick:number;endTick:number}
export interface CursorPlaybackChoice {
  generation:number;occurrenceIndex:number;startTick:number;
}
export interface PassagePlaybackChoice {
  generation:number;startOccurrence:number;endOccurrence:number;
  startTick:number;endTick:number;
}
```

`PlaybackPlan` gains **optional, non-null** `performedBeats?:PerformedBeat[]`. New generated plans always provide it, including `[]` when no beat is mapped. Old missing maps still render through the old API; selection controls report `Selected playback is unavailable for this prepared score.` and never guess a map. A present null rejects in both languages; TypeScript requires an array when the field is present. The field is transient, sent through the current plan worker/IPC with the plan. Rust `PlaybackPlan` gains `#[serde(default,deserialize_with="present_performed_beats",skip_serializing_if="Option::is_none")] pub performed_beats:Option<Vec<PerformedBeat>>`. Its plan-local deserializer calls `Vec::<PerformedBeat>::deserialize(deserializer).map(Some)`, so explicit null rejects while a missing field defaults to None and serializing None omits the field. Rust `PerformedBeat` uses `crate::project::BeatTarget`, `u32 occurrence`, and `f64` tick fields; `PlaybackSpan` has two f64s and derives Copy. Both structs use camelCase and deny_unknown_fields. Renderer consumes the map only through off-callback plan validation, not per sample.

Map validation: all targets are nonnegative u32 indices; target.track is within plan tracks; `(target,occurrence)` is unique and refers to an existing measure occurrence with that bar/ordinal. All ticks are finite; `0<=leadInTick<=startTick<=endTick<=plan.durationTick`. Zero-duration raw lookup rows are allowed; they do not independently produce a playable positive interval. Do not require a grace row/lead-in to start inside its owning measure. Sort rows by `(startTick,target.track,staff,bar,voice,beat,occurrence)` for deterministic output. Native can validate references present in the plan, not score-array existence; the frontend builder/resolver also validates the canonical score addresses. Validate once off callback.

`TransportCommand` gains exactly:

```ts
{type:'playRange';generation:number;startTick:number;endTick:number|null}
```

Matching Rust variant in existing `TransportCommand`:

```rust
PlayRange {
    generation:u64,
    start_tick:f64,
    #[serde(deserialize_with="crate::edit_types::required_nullable")]
    end_tick:Option<f64>,
}
```

**Missing endTick rejects**, even though its type is Option; null is meaningful, not a default. Reject extra fields, nonfinite/negative start, start at/after authored plan.durationTick, finite end<=start, or finite end beyond authored duration. `None` means unbounded ordinary native EOF, including a longer backing tail. `Some(end)` means a one-shot bounded by authored score time and cuts backing at the same nominal endpoint. No fake finite score-end span is stored for null.

`NativeAudioStatus` and frontend `PlaybackState` gain required `range:PlaybackSpan|null`, default null in the frontend unready state. It describes the acknowledged finite one-shot only; it is mutually exclusive with existing status.loop. durationSeconds/endTime remain whole native playback duration. Native `RuntimeSnapshot` and callback add `range:Option<PlaybackSpan>`; SharedStatus adds scalar atomics for presence/start/end under the existing seqlock/barrier. No heap object/mutex is introduced in callback status publication. New status fixtures supply range:null.

## Public performed-map builder

New owned module `src/audio/performed-beats.ts` exports:

```ts
buildPerformedBeats(score:model.Score,lookup:midi.MidiTickLookup,tickShift:number):PerformedBeat[]
```

Call it on the same prepared public model/full reference generation that produces the existing plan (after existing MIDI-only normalization); public clone IDs/indices remain mapped to the canonical score. Do not generate a second full score on the UI thread or alter generation order/events.

1. Enumerate the public masterbar array once and number each written bar's occurrences exactly as the existing plan does. Enumerate each public slice and its highlighted items. An item may be highlighted in several slices; it does **not** start anew at every slice.
2. Group slices by canonical BeatTarget and **owning performed occurrence**. Check moved-grace ownership before comparing bar indices: a grace with public beat.playbackStart<0 but nonnegative highlighted item.playbackStart belongs to the immediate next performed lookup when that lookup's bar equals target.bar. This also handles a one-bar repeat whose adjacent bar indices are equal. Otherwise ownership is the containing lookup whose masterBar.index equals target.bar; a first-measure negative slice belongs there. Merge split parts in the owning occurrence. Use public linked lookup/slice fields, not lexical next-bar arithmetic. Public highlighted playbackStart supplies the absolute start; the union of the item's contiguous highlighted slices supplies end. Apply `lookup.start + relativeTick + tickShift` exactly once. Prove split/overlap handling with literal multivoice examples; do not clamp away preceding grace time.
3. Preserve every actual row, including rests, ties, grace and the performed empty voice0 placeholder; omit absent unused-voice beats. Resolve canonical source addresses using the public item.beat's full parents/indices, never its pitch or a renderer projection's IDs. Unexpected non-grace ownership/ambiguous disjoint rows fail plan preparation with source coordinates rather than assigning another occurrence.
4. For each normal principal row, use its public `graceGroup.beats` and mapped rows in that owning occurrence to set leadInTick to their minimum start, including OnBeat/BendGrace. Keep the actual principal startTick unchanged. Grace rows themselves have leadInTick=startTick. A trailing/orphan grace remains its own raw row. Simile's played placeholder has leadInTick=startTick: it exposes only the public cursor placeholder, not borrowed source beat/grace attacks.
5. Return deterministic rows. Do not read private lookup maps/generator members, patch dependencies, add provenance MIDI to the full reference, or derive beat boundaries from PlanNotes. Existing note identity/GM MIDI agreement remains byte-for-byte unchanged.

## Pure canonical selection resolution

New `src/audio/selection-playback.ts` exports:

```ts
cursorPlaybackChoices(score:model.Score,plan:PlaybackPlan,target:BeatTarget):CursorPlaybackChoice[]
selectionPlaybackChoices(score:model.Score,plan:PlaybackPlan,selection:MusicSelection):PassagePlaybackChoice[]
requireCursorChoice(choices:readonly CursorPlaybackChoice[],choice:CursorPlaybackChoice):CursorPlaybackChoice
requirePassageChoice(choices:readonly PassagePlaybackChoice[],choice:PassagePlaybackChoice):PassagePlaybackChoice
```

Functions are pure, return detached arrays/objects, and validate all inputs. The require functions compare exact fields including generation against freshly computed choices; stale/malformed/forged choices reject before IPC. Reuse existing MusicSelection validation for notes/bars. For ranges use a small **playback-specific validator in this new module**: retain exact keys, integer/u32 written bar/tick coordinates, valid existing unique track/staff/voice lanes throughout addressed bars and a nonempty forward range, but bound written ticks by each public masterbar.calculateDuration(), not the editing validator's sum of selected-lane free-time beats. This deliberately permits the probed free-time silent tail at3360 in a public3840-tick measure; do not change the editing validator or copy its attack-filter resolver to establish performed time. Native endpoints remain finite performed f64 ticks.

- **Cursor:** each mapped row for target produces its occurrenceIndex and leadInTick (a clicked grace uses its own raw start). A zero-length row with positive following performance can start unbounded playback; an absent unused voice target cannot. Unknown/unperformed target reports `This score position has no performed playback location.`
- **Notes:** validate IndexedNoteTargets, deduplicate their beats, and compute the bounding selected beat interval from map lead-ins and raw beat ends. A tie destination selects its own written beat even though its sound began earlier. The renderer reconstructs held sound. A selected grace chooses its raw grace interval; selected principal includes its mapped grace lead-in. The UI says `Plays the bounding time passage with the current full mix.`
- **Bars:** start is the first chosen measure lookup start extended backward for mapped lead-ins in selected tracks; end is the last chosen lookup end. This retains complete bar clock/silent tails. Empty unused voices do not erase a bar selection.
- **Ranges:** process the exact written bar/tick endpoints for every selected lane. Positive-width normal rows use canonical public displayStart/displayDuration; a full-bar-rest, single empty-bar placeholder or simile placeholder uses `[0,master.calculateDuration()]`. At an exact start boundary choose the following principal's lead-in; at an exact end boundary choose the preceding beat's public end. Interior points interpolate through the principal's actual `[startTick,endTick)` body, not its grace prefix. Example OnBeat principal body120–960: written interior480/960 maps540; BeforeBeat principal body0–960 maps480, while its exact left edge includes -120 plus the global shift. This explicit body-relative interior policy is pending GP8 comparison. Underfull/unrepresented silent gaps use the actual measure clock offset, bounded by the public masterbar interval. At an end represented as next written bar tick0, normalize to the preceding written bar's end **before** matching performed occurrences; otherwise a skipped next ending would incorrectly invalidate the selected preceding bar. Compute the envelope across selected lanes (minimum start, maximum end), not per-lane muting.
- **Simile:** only the displayed placeholder beat is a cursor/beat target. A whole-bar selection works. Numeric sub-bar endpoints inside a collapsed simile reject with `Select the complete simile measure for playback.` rather than inventing hidden beat timing. A borrowed before-beat grace earlier than the placeholder is not included when starting directly on that mark; preceding performed playback can include it normally. No source notes/marks or ordinary playback are changed. This is an explicit fidelity limit.

Choices follow the existing **performed** itinerary. Require every selected written bar (those with positive intersection for a tick range, or first..last for a bar selection) and every explicitly selected note's beat target to occur in the candidate interval; no internally selected bar/target may be skipped. Silent/unused lanes do not require fabricated beat rows; their selected written bars still must occur. Simile requires its public placeholder, not hidden borrowed targets. For each eligible start occurrence choose the earliest forward end that satisfies this complete coverage and yields a positive interval; one choice per start, no Cartesian-product materialization. Literal example: itinerary `[0,1,0,2]`, written range0..2 offers only the first start0 because the second omits selected bar1; explicit notes only in bars0+2 may offer both start0 occurrences. A direction/repeat can route through additional written measures between endpoints; labels disclose that actual performed route. Do not stitch/remove intervening bars or substitute another ending. At least one valid choice is required. Reject zero/reversed/nonfinite spans; do not round an invalid interval into existence.

Use `startOccurrence/endOccurrence` as indices into plan.occurrences, not per-bar pass counts. The UI derives human labels from those entries, e.g. `Measure 1, occurrence 2 → measure 2, occurrence 2`. One choice auto-selects. Multiple choices show a selector initially `Choose performed occurrence`; no hidden first-occurrence fallback. Clear the selected choice when generation/cursor/selection changes; changing labels/session choice alone sends no native commands. The nearest-forward-end policy intentionally does not offer arbitrary multi-pass endpoint combinations; practice Loop repeats the chosen passage.

## Controller and visible workflow

Add to NativePlaybackController, retaining existing no-argument callers:

```ts
cursorPlaybackChoices(target:BeatTarget):CursorPlaybackChoice[]
selectionPlaybackChoices(selection:MusicSelection):PassagePlaybackChoice[]
playbackOccurrences():readonly Readonly<MeasureOccurrence>[]
play(cursor?:BeatTarget,choice?:CursorPlaybackChoice):void
playFromCursor(cursor:BeatTarget,choice:CursorPlaybackChoice):void
playSelection(selection:MusicSelection,choice:PassagePlaybackChoice):void
loopSelection(selection:MusicSelection,choice:PassagePlaybackChoice):void
```

These wrappers recompute choices using the current prepared plan/canonical built score and reject stale generation/address/interval before sending. While unready, controls are disabled and getters return empty arrays; actions throw the normal not-ready error. `loopSelection` sends existing setLoop with exact ticks and **does not autoplay**. No need for a second atomic loop-and-play command.

Root extends Transport props with current canonical cursor and MusicSelection|null. Show cursor/selection occurrence selectors and `Play from cursor`, `Play selection`, `Loop selection`; one selection disclosure keeps the existing compact toolbar usable. Primary Play passes cursor/choice when idle/ended without a loop, except for the explicit measure-Seek intent below; paused uses native Play to resume; an acknowledged configured loop takes precedence over the editing cursor. When several cursor occurrences exist, fresh cursor Play is disabled until chosen, while paused Resume, a configured loop and an explicit transport-position intent remain usable. Explicit Play from cursor restarts even while paused/playing and replaces the prior range/loop. Primary Pause is unchanged. `play()` with no cursor remains the existing low-level current-clock/resume API for external-media plumbing, explicit transport-position playback and old callers.

Preserve the existing measure Seek control through one Transport-local `nextStart:'cursor'|'position'`, initially cursor. After a locally valid explicit Seek request is issued set position; this expresses the user's next-start intent, **not successful native consumption** of the void controller call. The next fresh no-loop Play uses no-argument Play at the actual native transport position, with a concise title/hint `Play from transport position`; default cursor intent says `Play from score cursor`. A changed canonical cursor, Stop, generation/document change, asynchronous operation error, or explicit Play from cursor/Play selection resets cursor. Paused Resume and actual configured loop always take precedence. No copied selection context, additional clock, editor-selection mutation or old-status acknowledgement heuristic is introduced.

The standalone controls worker produces `SelectionPlaybackControls` in its own new module. Its exact props are `cursorChoices:readonly CursorPlaybackChoice[]`, `passageChoices:readonly PassagePlaybackChoice[]`, `occurrences:readonly Readonly<MeasureOccurrence>[]`, `cursorChoice:CursorPlaybackChoice|null`, `passageChoice:PassagePlaybackChoice|null`, `disabled:boolean`, `onCursorChoice:(choice:CursorPlaybackChoice|null)=>void`, `onPassageChoice:(choice:PassagePlaybackChoice|null)=>void`, `onPlayCursor:()=>void`, `onPlaySelection:()=>void`, `onLoopSelection:()=>void`. The parent Transport owns selected choices/resetting; controls emit callbacks only. The occurrence getter exposes the immutable prepared plan for labels, never a new writable timing source. Multiple-choice empty entries and full-mix/actual-route explanations are visible; no additional resource/library controls are added.

Root supplies ScoreView's existing **canonical** selected targets/ranges, not cloned renderer indices; selection revision has no audio side effect. The controller's native-ended handling must clear activeNotes for `practice.phase==='ended'`, including end<plan.durationTick; count-in/pending/stopped/error/generation filtering remains. Selected one-shot completion must not leave the next note showing as a paused instrument study. Display acknowledged finite range separately; never replace document endTime with it.

## Native command and endpoint ownership

Add `Renderer::score_duration_tick(&self)->f64` returning plan.durationTick; ordinary duration_tick continues to include backing tail. New command start/end validate against score_duration_tick, not the longer ordinary renderer duration. Start/end validation happens before modifying any transport state, both off callback and in CallbackTransport.

For accepted playRange, atomically clear loop and old finite range, cancel current count/pulses, reset trainer passes/start coefficient, install the optional finite span, resolve accepted tempo **before seek**, seek start, set playing/phase, then start the existing fresh count-in if configured. No output slot can occur between seek and start. A rejected/stale/not-ready request preserves tick, loop/range, count, settings, mix and run intent. Queue acceptance is not playback acknowledgement; range display uses native status only.

Callback adds one finite-range endpoint choice alongside existing loop/natural end: loop end if active, otherwise finite range end if present, otherwise ordinary renderer EOF. Use existing output_frames_until and current fixed/relative policy, then finish or wrap within the same buffer. Finite completion pins nominal tick/seconds to end, sets phase Ended, playing=false, count remaining0, pulse=null; completedPasses does not increment and between-loop count does not run. Remaining output slots are zero. Hard-cut backing/voices/FX tails at the one-shot endpoint; no historical FX-tail reconstruction or extra release-tail duration is promised.

**A frame budget alone does not guarantee exclusivity.** Current Renderer.frame dispatches near-tick events with `+1e-7`; that can leak an event exactly at a fractional endpoint. Add `render_until(&mut self,output:&mut[[f32;2]],end_tick:f64)->RenderStatus`, sharing the existing render path with a strict finite event ceiling. Every newly dispatched PlanNote attack, MIDI note/control/program/bend event and score metronome pulse must also satisfy `event_tick < end_tick`, without epsilon on that ceiling. Existing held voices may render samples before end. Apply this bounded path to configured loops and finite ranges. Ordinary render_into/stems/offline behavior keeps its existing unbounded path. A positive sub-sample interval consumes one sample at its start and no endpoint event; report/pin exact nominal end. No allocation/reset/reseek occurs for every frame; endpoint cleanup occurs once at transition using existing callback-safe reset/seek machinery.

Seeking reconstructs held note/program/controller/sustain state using existing seek logic and its accepted tempo; DSP history resets and recorded seek fade remain existing policies. Do not promise replay of historical reverb/delay tails or exact uninterrupted waveform identity after seek. Tests should establish correct state, onset/frequency, finite silence and consistent reset behavior, not false tail continuity.

## Exact transition policy

| Action/state | Required result |
| --- | --- |
| Fresh primary Play, no loop, idle/ended | Validated chosen cursor → playRange(start,null); ordinary score/backing EOF. |
| Fresh primary Play after explicit measure Seek, no loop | Transport position intent → existing no-arg Play at actual native tick; no false claim the preceding request was consumed. |
| Primary Play with actual loop | Existing native Play; retained loop governs fresh seek/count. Editing cursor does not replace it. |
| Pause / primary Resume | Preserve current finite range or loop, exact score/count position, pulse serial and passes. No new count unless existing fault policy requires it. |
| Explicit Play from cursor / Play selection | Atomic fresh start replaces loop/range and resets passes/count as above, including when already playing. |
| Native no-arg Play after finite range ended | Replay retained finite span from its start with fresh count; frontend primary fresh cursor action instead sends the explicit new unbounded command. This makes direct/legacy Play deterministic. |
| Stop | Clear finite range, cancel count, clear pulse, reset passes, seek0/idle; retain existing configured loop and practice settings. |
| SeekTick | Clear finite range, retain existing loop, cancel count/reset passes and preserve existing run/paused intent. |
| SetLoop (old measures or new selection) | Clear finite range, install exact loop, retain existing run/paused intent and seek-if-outside policy; no autoplay from idle/paused. |
| ClearLoop | Clear finite range too, cancel count/reset passes, retain tick/run intent; continue ordinary unbounded playback if already playing. |
| SetPractice / static mix update | Retain finite range/loop; existing practice tempo/count rules remain. Mix preparation preserve-install retains range. |
| Range completion / loop wrap | Completion ends once without pass/count; wrap increments passes and optionally counts through existing practice policy. Both obey strict exclusive event ceiling. |
| Musical edit/undo/redo; New/Open; invalidation/nonpreserve install | Clear finite range/loop and stale choices with generation; existing practice retention/reset rules remain. Presentation/settings-only history must not reprepare or clear an active span. |
| Healthy device switch/reselect | Quiescence snapshot/barrier and same seqlock retain finite span, tick/run/count/pass state; restore accepted tempo before seek; old epochs cannot publish. |
| Device fault/recovery | Retain finite span/tick/settings, recover paused; count interruption follows existing full-count-on-next-Play rule. Ended finite span remains ended on healthy recreation. |

Use the existing bounded serialized command queue for start/loop actions, with no new start-ack guard or request token. Show only native acknowledged range/phase/tick; do not optimistically claim a start was consumed. Invoke completion means queue acceptance only. A same-generation old status can match the same span/tick/phase, so those values must not be used as causal command acknowledgements. Repeated explicit restart clicks are ordered restart intentions; queue saturation reports an error without mutating accepted state. Existing practicePending, busy/unready/error and generation guards remain; Pause/Stop stay usable. Late statuses cannot revive another generation's range or active notes.

## Acceptance and honest limits

The plan pins shared protocol/mapping fixtures, meaningful RED/GREEN tests, no-heap callback checks, independent SMF agreement and native PCM/frame evidence. Required authored cases include silent beats/tied destinations, OnBeat/BeforeBeat/BendGrace/orphan grace, mixed voices and swing, pickup/free-time silent tail, simple/double simile, repeated/skipped/directed routes, backing longer than score, same-tick programs/CC64 and a fractional endpoint near the renderer epsilon. Live 44.1/48 kHz capture must prove no endpoint attack, exact one-shot/loop pass behavior and proper count/trainer transitions; screenshots alone are insufficient.

History/native reopen proves transport actions do not dirty/save settings or mutate source/lyrics/links/audio. Zoom/multitrack projection must preserve canonical selection. Run actual source/plan/reference corpus only if explicitly authorized and available locally; never copy/upload private data. Root owns desktop, devices, output listening and final accepted evidence.

Known limits remain explicit: hidden simile subdivisions/preceding borrowed grace are not fabricated; multiple-pass endpoint combinations and step audition are later work; original GP8 grace/interior-point/occurrence equivalence and physical macOS/Linux audio are unverified. A bounded P02/P03 delivery does not close the rest of P20, the historical inventory, or full GP8 parity.
