# Guitar Pro 8 practice transport design

Date: 2026-10-15. Status: approved for execution under the user's standing instruction to complete the parity goal using parallel workers without further approval questions. Refines [the umbrella design](2026-10-15-gp8-feature-parity-design.md); execution is in [the practice plan](../plans/2026-10-15-gp8-practice.md).

## Outcome and evidence boundary

Deliver custom relative speed, fixed BPM, progressive speed on existing loops, metronome volume/visual feedback, and count-in before playback/between loops. Settings belong to the open document's practice session and survive musical edit/undo/redo; explicit New/Open resets them. They never become score edits or persisted project settings. Editing selections never seek or set a practice loop implicitly.

This advances baseline **P04/P05/P06/P08/P09/P10** and the relevant parts of P20, while preserving P01/P07. Partial-bar/cursor playback P02/P03, step audition/navigation shortcuts, alternate click sounds/subdivisions, offline count-in F25, backing pitch/filters, relative tonality and fermata timing remain separate. The historical258-row baseline remains unchanged; authoring, actual audio and original GP8 acceptance require separate evidence.

The [official speed guide](https://www.guitar-pro.com/docs/gp8/audio/playback/speed) documents relative/progressive **10–300%**, fixed **10–300 BPM**, and fixed mode being unavailable with backing audio. The [tempo/metronome guide](https://www.guitar-pro.com/docs/gp8/audio/playback/tempo-metronome) documents volume, visual-only with volume0, count duration and between-loop count. The [playback guide](https://www.guitar-pro.com/docs/gp8/audio/playback/play) documents cursor/selection and step playback, reserved for follow-up. Cached PDF printed171–175 is `.analysis/parity/public-manual-pages.txt`, PDF pages177–181; URL-keyed text is `public-manual-pages.json`. No original target runtime was exercised for this design.

Explicit application policies pending GP8 runtime comparison: “Repetitions per speed” means complete practice-loop passes at each coefficient; hold terminal speed indefinitely. Count-in uses full written bars and denominator pulses, including a pickup's full written meter; free time uses its written meter. Count-in0–16bars, trainer1–100repetitions and the step bound below are application limits, not verified GP8 limits. Click sound choices, subdivisions and compound grouping are not established by the inspected manual.

## Global Constraints

- Native projects remain schema version **2**, engine version **1.8.4**; practice settings never enter EditCommand, history, GPIF, MIDI or score JSON.
- Use alphaTab **1.8.4**, fflate **0.8.3**, Rust **1.88** and the existing React/TypeScript/Tauri audio stack; no dependency changes.
- The native output callback is the only transport clock; no browser timer, Web Audio clock or second cursor clock schedules playback.
- Root owns shared contracts, plan/renderer/device/runtime/controller integration, Transport/App/export integration, Git, apps/builds and acceptance. Workers edit only assigned new modules and tests.
- Preserve source/archive/backing bytes, authored tempo maps, existing audio behavior and the approved slate/cream/lime layout; no adjacent refactoring.
- Validate complete settings before mutation/enqueue. Retain generation guards, callback epochs, coherent status snapshots and allocation-free live rendering/seek/loop transitions.
- Wire positions are zero-based; user measure/beat labels are one-based. Practice loops stay independent of editing selections.
- Model retention, native replay, notation, actual PCM and original GP8 runtime compatibility require separate evidence; full parity remains open.

## Wire types and validation

Root stages `src/audio/practice-types.ts` and matching Copy/Serde types in `src-tauri/src/audio/practice.rs`. Rust uses camelCase and `deny_unknown_fields` at every nested object/enum; `PracticeTempo` is tagged `kind`. Native repetitions are u32, bars u8, counters u64; the JSON shape is:

```ts
export type PracticeTempo =
  | {kind:'relative';ratio:number}
  | {kind:'fixed';bpm:number}
  | {kind:'progressive';start:number;end:number;step:number;repetitions:number};
export interface MetronomeSettings {enabled:boolean;volume:number;visual:boolean}
export interface CountInSettings {bars:number;betweenLoops:boolean}
export interface PracticeSettings {
  tempo:PracticeTempo;metronome:MetronomeSettings;countIn:CountInSettings;
}
export interface PracticePulse {
  serial:number;beat:number;beatsPerBar:number;accent:boolean;counting:boolean;
}
export interface PracticeStatus {
  settings:PracticeSettings;
  phase:'idle'|'countIn'|'playing'|'paused'|'ended';
  countInRemaining:number;completedPasses:number;
  effectiveRatio:number;currentBpm:number;pulse:PracticePulse|null;
}
export interface PracticeLoop {startTick:number;endTick:number}
export const DEFAULT_PRACTICE:PracticeSettings = {
  tempo:{kind:'relative',ratio:1},
  metronome:{enabled:false,volume:.4,visual:false},
  countIn:{bars:0,betweenLoops:false},
};
```

All numeric fields are finite. Ratios/start/end are `[.1,3]`; `end>=start`; step is `(0,2.9]`; repetitions integer `[1,100]`; fixed BPM `[10,300]`; volume `[0,1]`; bars integer `[0,16]`; flags are actual booleans. Equal trainer endpoints are valid. Reject unknown/missing/extra nested fields atomically. No invalid input is silently clamped. Fixed with **any** backing, including muted backing, fails with `Fixed tempo is unavailable while a backing track is present.`

Replace native `SetSpeed`/`SetMetronome` wire variants with `{type:'setPractice',generation:number,settings:PracticeSettings}`. Other transport commands keep their shape. Commands are ephemeral, so there is no persisted migration. `audio_prepare` retains its optional practice argument and defaults it to DEFAULT_PRACTICE. `device.rs` re-exports PracticeSettings to preserve current native imports; `runtime.rs::audio_prepare` is the current IPC entry.

`NativeAudioStatus` gains required `practice:PracticeStatus` and `loop:PracticeLoop|null`. Existing `speed`/`metronome` are derived aliases for effectiveRatio/accepted enabled; no second setting source. `PlaybackState` gains those fields, front-only `practicePending:boolean`, and `practiceNotice:string|null`; existing speed remains percent. Unready default currentBpm is0, otherwise actual positive quarter-note BPM. Count remaining includes the current pulse, stays nonzero while a count is paused, and is0 outside a live/paused count. Pulse serial increments on actual native pulses and freezes on pause; Stop clears pulse.

Extend each `MeasureOccurrence` in TS/Rust with required `meterNumerator:number`/`meterDenominator:number` (native u32). Emit the written master-bar values, independently of a pickup's clipped clickTicks. Numerator is positive u32; denominator is one of **1,2,4,8,16,32,64,128,256**. Current `src/editor/notation.ts` permits those denominators and has no32 numerator cap; do not introduce one. Count math separately rejects oversized pulse counts/u64 frame overflow/sub-one-frame pulse periods before prepare/enqueue; a count request must not impose a global saved-tempo cap. Update authored plan fixtures, not score-editing DTOs.

## Pure worker contracts

Frontend worker owns `src/audio/practice.ts`, `PracticePanel.tsx` and their tests, consuming root-staged types:

```ts
export function validatePractice(settings:PracticeSettings,hasBacking:boolean):void;
export function practiceForBacking(settings:PracticeSettings,hasBacking:boolean):{
  settings:PracticeSettings;notice:string|null
};
export interface PracticePanelProps {
  settings:PracticeSettings;busy:boolean;hasBacking:boolean;
  onChange:(settings:PracticeSettings)=>void;
}
export function PracticePanel(props:PracticePanelProps):React.JSX.Element;
```

Validation throws before IPC, checks exact shapes and never mutates input. `practiceForBacking` returns a detached valid settings copy; only a fixed-to-backing transition changes tempo to relative1, with notice `Fixed tempo disabled because this score has backing audio.` Other fields remain intact.

Native worker extends `practice.rs` with pure scalar primitives and owns `src-tauri/tests/audio_practice.rs`. `PracticeSettings::validate(&self,has_backing:bool)->Result<(), &'static str>` checks shape-independent semantic bounds; Serde supplies exact shape validation. Native helper types are Copy and contain no heap allocations:

```rust
pub enum RenderTempo { Relative {ratio:f64}, Fixed {bpm:f64} }
pub struct PulsePosition {pub beat:u32,pub beats_per_bar:u32,pub accent:bool}
pub struct CountInSnapshot {
  pub bars:u8,pub numerator:u32,pub denominator:u32,pub bpm:f64,
  pub rate:u32,pub elapsed_frames:u64,pub total_frames:u64,pub emitted_pulses:u32,
}
pub struct CountFrame {
  pub pulse:Option<PulsePosition>,pub remaining:u32,pub finished:bool,
}
pub fn progressive_ratio(settings:&PracticeTempo,completed_passes:u64)->f64;
impl CountInClock {
  pub fn new(bars:u8,numerator:u32,denominator:u32,bpm:f64,rate:u32)
      ->Result<Self,&'static str>;
  pub fn next_frame(&mut self)->CountFrame;
  pub fn remaining_wall_seconds(&self)->f64;
  pub fn snapshot(&self)->CountInSnapshot;
  pub fn from_snapshot(snapshot:CountInSnapshot,rate:u32)->Result<Self,&'static str>;
}
impl ClickVoice {
  pub fn new(rate:u32)->Self;
  pub fn trigger(&mut self,accent:bool);
  pub fn frame(&mut self,volume:f64)->f32;
}
```

`progressive_ratio` is called only with a validated progressive variant and returns `min(end,start+floor(completedPasses/repetitions)*step)`. Passes50,50,70,70,90,90,100…% result from start.5/end1/step.2/repetitions2. No explicit Loop means no automatic trainer repeat.

Count bars0 produces an already-finished clock. For a live count freeze starting actual BPM/meter: pulse period is `60/BPM*4/denominator` wall seconds; schedule from rounded absolute cumulative frames, not repeated rounded intervals. `next_frame.finished` means no count sample is consumed by that call; the caller uses that output slot for score audio. Remaining includes the current pulse until the final count sample. Pause simply stops calling next_frame. Snapshot restoration changes sample rate by preserving elapsed/remaining wall duration to the nearest new sample and emitted_pulses, so no pulse is replayed. Count constructor checks total pulses fit u32 and total frames fit u64; live count plans are prevalidated off callback.

Snapshot total_frames preserves the actual rounded endpoint across device rates. Recomputing a canonical endpoint from BPM can lose several destination samples after a large rate increase. Rescale actual elapsed and total frame boundaries with integer nearest rounding; their difference preserves remaining wall duration within one new sample, including repeated restoration. Publish both under the same runtime seqlock.

ClickVoice retains existing2400Hz accent/1800Hz ordinary,50ms exponentially decaying sine. Wave amplitude is `.25*volume`; default.4 reproduces current.1 amplitude. It never allocates. A new pulse retriggers it. Normal pulses are generated when audible or visual metronome is enabled; only enabled with positive volume sounds. Count generates pulses independently of playback-metronome enabled and uses the same volume.

## Native integration and transitions

`Renderer.seconds` remains authoritative **nominal authored score time**. Relative/progressive advances it by resolved ratio/rate. Fixed derives current tick through the authored Timeline, adds `BPM*960/(60*rate)` ticks and maps back to nominal seconds each frame. DSP receives actual BPM; plan.tempos/durationMs/occurrence times remain unchanged. Backing keeps using this same nominal clock; fixed mode is rejected before it can reach backing.

Root adds renderer methods `set_practice_tempo(RenderTempo)->Result<(),String>`, `set_metronome_settings(MetronomeSettings)`, `output_frames_until(end_tick:f64)->usize`, `authored_bpm_at(tick:f64)->f64`, `meter_at(tick:f64)->(u32,u32)`, `has_backing()->bool`. Keep `set_speed(f64)` and `set_metronome(bool)` as relative/default-volume adapters for existing offline callers. The callback resolves progressive settings to RenderTempo::Relative and is the only trainer counter owner.

`output_frames_until` uses nominal-seconds delta*rate/ratio in relative mode, tick delta*60*rate/(BPM*960) in fixed mode, ceil with epsilon and minimum1 for positive remainder. It replaces the callback's existing constant speed division at loop boundaries and natural end; pin end position rather than overshooting a full callback buffer.

RenderStatus gains `pulse_count:u32` and `last_pulse:Option<PulsePosition>` for that render call. CallbackTransport owns the published serial, adds renderer pulse counts and increments for count pulses. UI may display the latest skipped-over pulse, never schedule missed ones itself. Preallocated renderer scratch already reserves track count+2; preserve offline metronome stem indexing when visual-only is active.

CallbackTransport owns settings, phase/resume phase, passes, count clock and count click. During count it renders only click samples, freezes renderer notes/backing/DSP/tick/seconds, then renders score into the remainder of the **same** callback buffer. No mutex, resource load, heap operation or wall-clock query occurs at count/loop transitions.

| Trigger | Required result |
|---|---|
| Fresh Play | If outside active loop, seek loop start; ended without loop restarts0. Reset passes/start coefficient, then count if configured. Play already running is idempotent. |
| Pause / resume | Silence/freeze exact score or count position, serial and passes. Play resumes without restarting a count. |
| Stop | Cancel count, clear pulse, reset passes, seek0, idle; retain settings/loop. |
| Loop wrap | Increment completedPasses once, resolve next coefficient, seek/reconstruct source state, then optionally count at the **new** coefficient. Hold terminal speed until Stop. |
| Natural end | End once without creating a trainer loop. |
| Seek/SetLoop/ClearLoop | Cancel count, reset passes/coefficient; retain running/paused intent. No new count until fresh Play or next configured wrap. Preserve existing out-of-range loop seek rules. |
| Apply changed settings | Atomic; retain tick/run intent. A tempo change resets passes and coefficient. New count duration applies next count; volume/visual apply immediately. Do not restart an existing count or alter its frozen BPM/meter. |
| Musical edit/undo/redo | Stop, clear loop/count/pass; retain last acknowledged settings for new generation. |
| Explicit New/Open | Reset settings/runtime even for identical source bytes. |
| Backing added during fixed | Frontend normalizes to relative1 before prepare, shows notice. Native prepare/command still reject fixed+backing even when muted. |
| Healthy device switch | Preserve generation/tick/run phase/pass/settings and remaining count wall duration at new rate. Retired stream epochs cannot publish. |
| Device fault/recovery | Stop output; recover same generation/tick/settings paused. If fault interrupted a count, next Play starts a full configured count; otherwise resume score. Never silently resume partial count. |

Use a coherent native runtime snapshot alongside status for stream recreation: `phase`, resume-is-count flag, `Option<CountInSnapshot>`, completed passes, published pulse/serial and interrupted-count flag, plus existing tick/seconds/generation. Read all under the same SharedStatus seqlock; store scalar atomics, not a callback lock. A settings copy/remaining beat integer cannot restore sub-beat progress. Healthy switch restores count from_snapshot; fault marks restart-count instead.

## Controller, panel and export

Controller adds `setPractice(settings:PracticeSettings):void`, `exportPracticeRatio():number|null`. It may keep setSpeed(percent) selecting relative mode and setMetronome(volume) as convenience adapters. New panel uses complete settings directly. One pending Apply at a time: practicePending stays true until matching native settings acknowledgement or failure/new generation; enqueue completion is not acknowledgement. Unchanged Apply is a no-op. Native service saves only validated/enqueued settings; displayed active state is callback acknowledged. Error retains active settings and editable panel draft.

PracticePanel keeps one detached draft and **Apply practice settings**. Draft changes do not dispatch immediately; volume then visual preserves both. Reset draft only when accepted settings genuinely change, not on every playback pulse; root remounts panel on explicit documentEpoch change. Busy disables Apply. Controls are Relative/Fixed/Progressive,10–300% input,10–300BPM input, trainer start/finish/increment in percentage points/repetitions per speed, metronome, volume0–100%, visual, count bars0–16 and between-loop count. Fixed is disabled/explained with backing. Preserve existing transport measure seek/loop; pressed Loop uses acknowledged loop, not local boolean.

Transport displays acknowledged actual BPM/coefficient/pass/count plus accessible pulse text with `data-pulse-serial`; no rapid aria-live flashing. Count text can use polite role=status. Visual changes use native serial; CSS animation is decorative only and respects reduced motion. No transport timer.

During count native playing=true means callback running, but alphaTab stays paused and receives unchanged nominal position. activeNotes is empty for live/paused count, and remains native-tick driven in score play/pause. Never turn a native fixed-mode status update into alphaTab playback-rate-driven relative settings.

`exportPracticeRatio()` returns relative coefficient or the current progressive coefficient as a **constant** export speed; fixed returns null. Change existing “Current practice speed” label to **Current speed coefficient**. ExportDialog gains `currentSpeedAvailable:boolean`; disable that option in fixed mode and reset an already selected unavailable option to saved. `useExportCoordinator` accepts `currentSpeed:number|null` and rejects a current-speed request with null before creating a job. Saved-speed export remains available. Widen offline relative validators to.1–3; live count/visual settings never silently enter export. F25 remains open.

## Acceptance and known limits

The plan's independent PCM/frame arithmetic is normative: quarter attacks at10/123/300%, fixed90BPM across120→60source tempo, a fixed loop crossing that change,3/8count at36,000frames/48k, progressive count/score cycles, pause, silent visual pulses, backing transient delay and device-rate restoration. Compare actual frames/pitches/source hashes and project snapshots; status alone is insufficient. Include existing allocation guards and actual Windows CPAL plus bounded WASAPI loopback with no second synth.

Original GP8 trainer repetition/terminal and pickup/compound count semantics remain unverified; physical macOS/Linux acceptance and offline count-in remain open unless actually exercised. P02/P03/step require a later performed-beat map including rests/graces/repeats/simile/voice identities; do not derive one from note attacks or import editing-range semantics. Source fixture and installed vendor payloads remain untouched.
