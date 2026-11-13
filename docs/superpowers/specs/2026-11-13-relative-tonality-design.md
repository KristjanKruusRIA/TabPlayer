# Global relative tonality: design (THE-57, P12)

Status: accepted 2026-11-13. Ticket THE-57 ("Finish the remaining practice controls (P08, P12, P20)"), tracker row P12 in `docs/validation/2026-10-15-gp8-parity-progress.md`; it also moves the relative-key part of P20 and builds on P17 (backing semitone and cents, delivered). P08 (metronome sound) is delivered. `file:line` references were read at `6ad2d6f` (develop) in the worktree. Written for an implementer who has not read the codebase.

## Must not change

- **The score, the project and its history.** Relative tonality is not an edit. It writes nothing to a `.tabplayer` file, adds no edit command and no `DocumentSettings` field, and never changes the notation, a tab number or a tuning. Old projects and edit logs replay exactly as before.
- **Sound at a shift of 0.** With no shift (the default) every renderer, plan, resource set, status message and export is byte-for-byte what it is today. This includes the backing track: at an extra shift of 0 the existing expression at `src-tauri/src/audio/backing.rs:269` is used unchanged.
- **Percussion.** Percussion tracks (`PlanTrack.percussion`) and everything on plan channel 9, including the golpe knocks (`src/audio/golpe.ts:11`), are never transposed.
- **Exports.** MIDI, Guitar Pro, MusicXML, ASCII tab, PDF, image and audio exports stay in the original key. Nothing in `src/export/` or `src-tauri/src/export/` changes.
- **Backing settings.** `BackingProcessing::validate` (`src-tauri/src/settings.rs:557-564`: integer semitones -12 to 12, integer cents -100 to 100) is not loosened, and the saved `processing` value is not rewritten by the key shift.
- **The audio thread.** No allocation, lock or file access is added to the audio callback. All new work runs on the control side; the callback receives a prebuilt renderer through the existing `Install` command.
- **Tuning, capo and transposition stay separate concepts** (`PRODUCT.md`). The key shift is a fourth, playback-only one, and its copy must not call itself a transposition of the score.
- **Speed and loops.** `setSpeed`, loops, count-in and progressive practice behave as before. Applying a key shift never restarts playback, clears a loop or re-prepares the plan.
- **New UI text** goes through `src/i18n` with `en`, `et` and `de` entries, and a control that holds focus never gets `disabled` for busy (`src/ui/useBusyGuard.ts:17`).

## Goal

A practice control that moves the sound of the whole piece up or down by whole semitones, from -12 to +12, without touching the notation: the score, the instrument views and the exports keep showing and writing the original key. It sits beside speed, applies while playing, and carries the backing track and any external MIDI output with it.

## What Guitar Pro 8 does

- **From the tracker:** row P12 is "Tempo curves, units and global relative tonality". Its acceptance is "Author other tempo units and shift whole playback including backing without score edits". Its current gap, before this work, is "tempo units/global relative key absent" (units were delivered 2026-10-31). Row P20's remaining gap lists "relative-key" among the practice interpretations still incomplete.
- **From the manual page fetched 2026-11-13** (`…/audio/backing-track`, the page the tracker cites for P20): the overview says the audio track's playback is affected by settings such as relative tempo and "relative tonality". It does not say where that setting lives, its range, or whether it also moves score notes, the metronome or drums. The page's own semitone and cent controls are separate audio-track controls, with no range given.
- **From the manual page fetched 2026-11-13** (`…/score/track-settings/tonality-transposition`): "relative tonality" is also used there in another sense, the notation of a transposing instrument when concert tonality is off. That is a per-track notation matter (tracker row S21), not this feature. The page describes no global playback transposition.
- **From the manual page fetched 2026-11-13** (`…/audio/automations/volume-pan-tempo`, the page the tracker cites for P12): it says nothing about relative tonality.
- **Assumed:** the manual is ambiguous, so this design follows the tracker's acceptance text: a playback aid that shifts everything that sounds, backing included, with no score edit. The range of +-12, the placement beside speed and the additive rule for the backing are TabPlayer decisions, not measured Guitar Pro behaviour. The PDF pages the tracker cites (92-95, 128, 170-177, 202-216) were not read.
- `docs/validation/2026-10-31-gp8-tempo-units.md:25` assumed a document setting and a shifted MIDI export. This design supersedes both: the acceptance says "without score edits", and a rehearsal aid is a session control like speed.

## Decisions by the owner (2026-11-13)

- The shift is **session-only** and **resets on a document change**, like speed.
- The range is **-12 to +12** semitones.
- **Exports stay in the original key.**
- The audio-export "current key" option is **not part of this work**. It is recorded below as a possible follow-up.

## What exists

### Speed is a session practice setting, which tonality joins

- `PracticeSettings` is `{tempo, metronome, countIn}` (`src/audio/practice-types.ts:11`). `DEFAULT_PRACTICE` is at `:18`. The optional `metronome.sound` (`:9`) is the precedent for adding an optional field.
- The controller holds it and resets it on a document change (`src/audio/NativePlaybackController.ts:303`). `setPractice` (`:143`) validates, remembers it as pending and sends `{type:'setPractice'}`; the status acknowledges it, compared by `practiceKey` (`:26`). `idlePractice` is at `:27`. A new prepare after an edit passes the current practice (`:327`, `:335`).
- Validation is strict on both sides: `exact(settings, ['tempo','metronome','countIn'])` (`src/audio/practice.ts:38`), with `sound` allowed optionally (`:50`); Rust `PracticeSettings` has `deny_unknown_fields` (`src-tauri/src/audio/practice.rs:81-87`) and a `#[serde(default)] sound` (`:26-28`); `validate` is at `:108`.
- Three places rebuild a `PracticeSettings` field by field and would **silently drop a new field**: `practiceForBacking` (`src/audio/practice.ts:58-62`), `PracticePanel.apply` (`src/audio/PracticePanel.tsx:29`) and its `acceptedKey` (`:21`).
- Native: `SetPractice` is applied in the callback at `src-tauri/src/audio/device.rs:1335-1344`, and re-validated at `:2907`. The status echo is rebuilt from scalar atomics in `SharedPractice` (`:289-371`, `store` at `:318`, `read` at `:346`). `PracticeStatus` is defined at `:89` and carried in `NativeAudioStatus.practice` (`:136`). 24 `PracticeSettings {` struct literals exist in 10 files (`device.rs`, `practice.rs` and eight under `src-tauri/tests/`).

### Plan keys, samples and the golpe

- `PlanNote.key` (`src-tauri/src/audio/plan.rs:103-130`) and the `noteOn`, `noteOff` and `noteBend` keys of `PlanMidiEvent` (`:138-185`) are sounding keys, so capo, tuning and open strings need no special handling. `PlanTrack.percussion` is at `:54`.
- Golpe knocks are `plan.midi` events on `GOLPE_CHANNEL` 9 of melodic tracks (`src/audio/plan.ts:465-470`); channel 9 has percussion-bank semantics in both synthesizers (`plan.ts:176`).
- Recorded samples are chosen **at prepare time**: `resource_requests` (`src-tauri/src/audio/voices.rs:260`) loads regions by note key, and `select_region` (`voices.rs:9`, called at `renderer.rs:819`) takes the nearest region through `eligible_regions` (`resources.rs:106`). A key outside the recorded range never fails: the nearest region is used and pitch-shifted by its keytrack, so range limits degrade by resampling. The bundled guitar regions span keys 40 to 86; the bass regions are declared 0 to 127 (`src-tauri/resources/audio/manifest.json`). A key above 127 or below 0 cannot exist.

### A seamless re-install already exists

- `set_mix_inner` (`device.rs:2748`) has a branch (`:2806-2843`) that, when the sound source changed, reloads resources for the old plan, builds a renderer through `routed_renderer` (`:2106`) and enqueues `CallbackCommand::Install { preserve: true }`. `install_with_practice` (`:1052-1119`) then carries on at the same tick and releases held MIDI notes.
- Every renderer is built by `renderer_with_callback_frames` (`:2605-2658`). `PreparedDocument` (`:1956`) already carries `practice`. Resources are loaded in `prepare_current` (`:2524`, load at `:2544`) and in `set_mix_inner` (`:2810`).
- A full re-prepare from the front end stops playback (`beforeScoreChange`, `NativePlaybackController.ts:271`) and rebuilds the alphaTab plan, so it is not used.

### Backing, MIDI output and exports

- `BackingVoice::new_with_processing` (`src-tauri/src/audio/backing.rs:213`) validates the processing (`:219`), then `step *= 2^(pitch/12)` with `pitch = semitones + cents/100` (`:269`). It is reached from `Renderer::install_processed_backing` (`renderer.rs:2197`), called at `device.rs:2655` for playback and `src-tauri/src/runtime.rs:1535` for export, and by many tests (`tests/backing_processing.rs`).
- `docs/validation/2026-10-16-gp8-backing-processing.md:12-13`: the manual semitone and cent values stay separate, the audible pitch is their additive total, and the tested combined endpoints are +-13 semitones.
- External MIDI output (A26) sends what the renderer plays: its tap is built for the renderer (`routed_renderer`, `device.rs:2114-2119`).
- Audio export already offers `Speed: saved | current` (`src/export/useExportCoordinator.ts:67-69`, `src/export/ExportDialog.tsx:107`, `src-tauri/src/export/audio.rs:22,162`), fed by `exportPracticeRatio` (`NativePlaybackController.ts:150`, `src/App.tsx:421-423`). MIDI, GP, MusicXML, PDF and ASCII exports are built from the score in TypeScript and never see practice settings.

## Design

### 1. A session practice setting

`PracticeSettings` gains `tonality`: an integer number of semitones, -12 to +12, absent or 0 meaning the original key. It follows speed: one validated, acknowledged native state, the existing `practicePending` feedback, reset by a document change. Rejected: a document settings edit (schema, old-build refusal and undo noise for a rehearsal aid, against the tracker's "without score edits"); a separate transport command (it would duplicate the pending and acknowledgement machinery).

In TypeScript the field is optional, like `sound`, so a settings object without it is valid and means 0. In Rust it is `#[serde(default)] pub tonality: i8`, validated to -12..=12.

### 2. A native copy of the plan, not a front-end rebuild

New `src-tauri/src/audio/tonality.rs`: `transposed_plan(plan: &Arc<PlaybackPlan>, semitones: i8) -> Arc<PlaybackPlan>`.

- A shift of 0 returns the same `Arc`.
- Otherwise the plan is cloned (the pattern already used by the locked-sound adaptation in `voices.rs`, around `:239-244`) and:
  - `PlanNote.key` is shifted for notes whose track is not `percussion` and whose `channel` (absent means 0) is not 9;
  - `noteOn`, `noteOff` and `noteBend` keys are shifted by the same rule;
  - results are clamped to 0..=127, by the same function for notes and events, so the renderer's pairing of a note to its `noteOn` by `(track, channel, key, tick)` (`renderer.rs:896-940`) stays consistent;
  - `kit_sound`, `kitElement`, programs, controllers, bends, ticks and the pitch curves are untouched.
- Rejected: shifting in `plan.ts` and re-preparing (stops playback, drops loops, rebuilds the alphaTab plan on every click); shifting keys at trigger time (the region was chosen for the original key, so the timbre is worse, and the samples for the new keys would not be loaded).

### 3. Applied through the preserved install

- `PreparedDocument` gets `render_plan(&self) -> Arc<PlaybackPlan>`, which is `transposed_plan(&self.plan, self.practice.tonality)`. It is used at every place a document's plan feeds the renderer or its resources: `prepare_current` (`device.rs:2544`), the `set_mix_inner` reload (`:2810`) and `renderer_with_callback_frames` (`:2628`). The stored `plan` stays the original: ticks, occurrences, the reference-sync map and the channel routing (`midi.build_route`) read it unchanged.
- In `command()` (`device.rs:2870`), a `SetPractice` whose `tonality` differs from the document's builds the new document, loads `resource_requests(&render_plan, &settings)`, builds the renderer through `routed_renderer`, and only then enqueues, in order, the ordinary `Transport(SetPractice)` (so the callback's practice and the status echo update) and `Install { preserve: true }`. It then commits the route and replaces `state.document`, exactly as `set_mix_inner` does (`:2831-2843`). Any failure returns an error before anything is enqueued, and nothing changes. A `SetPractice` that does not change `tonality` takes today's path (`:2934-2940`).
- A shift made while playing continues at the same tick; held external MIDI notes are released and re-struck by the existing install code (`:1106-1113`).

### 4. External MIDI output follows (assumed)

The sender reads the shifted renderer, so a routed melodic track is sent in the practice key, and percussion on channel 10 is not shifted. Reason: a routed track is still playback, and a player who shifts the key expects the whole of it to move; sending original keys to one synth while the rest moves would be confusing. This is a TabPlayer decision, not measured Guitar Pro behaviour. The MIDI-out panel hint says so.

### 5. The backing track adds the shift

- The effective shift of the backing is its own saved semitones and cents plus the key shift. This matches the tracker acceptance ("including backing") and the musical meaning: the backing's own shift aligns the recording with the score, the key shift moves everything. Rejected: the key shift overriding the manual shift, and leaving the backing out.
- `new_with_processing` and `install_processed_backing` keep their signatures, so their ~15 callers (tests and `runtime.rs:1535`, which is the export and stays in the original key) are untouched. Add `BackingVoice::new_with_processing_shifted(audio, map, rate, processing, extra_semitones: i8)` and `Renderer::install_processed_backing_shifted(..., extra_semitones)`, and make the old functions call them with 0. Only `device.rs:2655` calls the shifted one, with `document.practice.tonality`.
- `processing.validate()` still runs on the saved value. With a nonzero extra the pitch is summed in integer cents and divided once, so a cancelling pair (manual +3, key -3) is exactly neutral and takes the unprocessed path; with an extra of 0 the existing expression is used.
- The effective total reaches +-25 semitones. The tested range is +-13, so quality beyond it is unmeasured and is a stated limit.
- A key-shift change reinstalls the renderer, so the backing voice is rebuilt at the current position through the same preserved path.

### 6. What is not shifted

The metronome and count-in, Line-In, note auditions (hearing a note while editing), the instrument-view highlights (they follow written notes) and all exports.

## Interfaces

```rust
// src-tauri/src/audio/practice.rs
pub struct PracticeSettings { /* ... */ #[serde(default)] pub tonality: i8 }   // validate: -12..=12
// src-tauri/src/audio/tonality.rs (new; add `pub mod tonality;` to audio/mod.rs)
pub fn transposed_plan(plan: &Arc<PlaybackPlan>, semitones: i8) -> Arc<PlaybackPlan>;
// src-tauri/src/audio/backing.rs and renderer.rs
BackingVoice::new_with_processing_shifted(audio, map, sample_rate, processing, extra_semitones: i8) -> Result<Self, String>;
Renderer::install_processed_backing_shifted(&mut self, audio, map, mix, processing, extra_semitones: i8) -> Result<(), String>;
// device.rs
impl PreparedDocument { fn render_plan(&self) -> Arc<PlaybackPlan>; }
// SharedPractice gets `tonality: AtomicI8`, written in store() and read in read().
```

- The 24 `PracticeSettings {` literals take `tonality: 0`, or `..Default::default()` where that reads better.
- TypeScript:
  - `practice-types.ts`: `PracticeSettings.tonality?: number`; a helper `tonalityOf(settings) => settings.tonality ?? 0`, as `clickSoundOf` does.
  - `practice.ts`: `validatePractice` accepts the optional key, requires an integer from -12 to 12 (a new code `tonality` with a `PRACTICE_MESSAGES` entry and a `practice.error_tonality` string), and `practiceForBacking` carries it.
  - `PracticePanel.tsx`: `apply` and `acceptedKey` carry it, so applying the panel never resets the shift.
  - `NativePlaybackController.ts`: `practiceKey` includes it; `idlePractice` and the echo carry it.

## UI

- A new `transport-key` group after `transport-speed` and before `transport-more` (`src/Transport.tsx:213-218`): a caption "Key", a lower button, the value ("+2", "0", formatted with `Intl.NumberFormat(lang, {signDisplay:'exceptZero'})`), a raise button, and an "Original key" reset. The group has `role="group"` and an accessible name; every button has an accessible name and a title.
- All controls use `busyGuard` with `busy` and `unavailable` (`practicePending`, the limits, and a shift of 0 for the reset), never `disabled` for busy, so a control that holds focus keeps it (`src/ui/useBusyGuard.ts:17`). The reset stays rendered while at 0, `aria-disabled`, so the row does not change width.
- Writes go through `player.setPractice({...structuredClone(practice.settings), tonality})` inside `act(...)`, as the metronome toggle does (`Transport.tsx:211`). The existing "Applying practice settings" message covers the re-install delay (`transport.applying_practice`, `src/i18n/en.ts:280`).
- **Small windows (THE-196, merged at `6ad2d6f`).** The Loop, Click and Speed groups show a compact caption above the controls, set by two rules in `src/workstation/gp-shell.css:65` and `:67`, pinned by `src/shell/small-window.css.test.ts:18-19`, `:28` and `:61`. The Key group must be added to both `:is(...)` lists and to those tests. The window minimum is 960 by 600 (`PRODUCT.md`). The row's width at 960 was **not measured**; the implementer measures it. If the transport overflows, the Key group goes inside "More playback" (`Transport.tsx:218-224`) instead and says so in the validation note.
- No default keyboard shortcut: `[` and `]` are speed (`src/App.tsx:877-878`) and the brackets with Shift are layout-dependent. Add command-palette entries beside `slower` and `faster` (`src/editor/command-palette.ts:75-76`) for lower, raise and reset, which also gives keyboard access with a shortcut-free route; the buttons are ordinary tab stops.
- `PracticePanel` does not get a field. It must only preserve the value (see Interfaces).
- Hints: a line in `BackingProcessingControls` ("The practice key shift of {value} is added to this") shown only when nonzero; a line in `MidiOutPanel` (`midi_out.hint`, `src/i18n/en.ts:101`, plus a new key) that routed notes are sent in the practice key; the help topic that names the speed keys (`src/help/help-topics.ts:146`) gains one sentence.
- **i18n** (en, et, de): `transport.key`, `transport.key_lower`, `transport.key_raise`, `transport.key_reset`, `transport.key_value`, `practice.error_tonality`, `backing.key_shift_added`, `midi_out.key_shift`, `palette.*` entries, and the help sentence.

## Compatibility and replay

- Nothing is persisted. There is no schema, no edit log entry and no replay question, and old builds are not affected. A mixed Rust and front end cannot occur because they ship together.
- The shift is lost on a document change (the controller resets practice, `NativePlaybackController.ts:303`) and on restart.
- The status echo carries `tonality` through `SharedPractice`, so the page's acknowledgement check (`practiceKey`) sees it.
- `PracticeSettings` is public Rust API used by integration tests: the literals are mechanical edits.

## Hostile input and realtime

- **Audio thread.** Unchanged. The callback receives a finished `Box<Renderer>` through `Install`, and the old renderer is returned and dropped off-thread (`install_with_practice`, `device.rs:1115-1118`). The only new callback-visible state is one relaxed `AtomicI8` in `SharedPractice`, read for the status.
- **Input bounds.** `tonality` is validated to -12..=12 in TypeScript and again in Rust at the command boundary (`device.rs:2907`) and in `audio_prepare`, so no other value reaches `transposed_plan`. Keys are clamped, so no `u8` wraps.
- **Memory and time.** The plan copy is transient on the control thread and about doubles plan memory while it exists; resource loading is bounded by `resource_requests`, the same bound as a sound change. The control lock is held across it exactly as `set_mix_inner` does.
- **Failure.** A failed resource load or renderer build leaves the document, the renderer and the shown shift unchanged, and the page shows the existing practice error.

## Test plan

- **Rust unit, `tonality.rs`:** melodic keys shift; a percussion track and any channel-9 note or event do not; golpe events do not; `noteBend` keys follow; clamping at 0 and 127 with notes and events still paired; a shift of 0 returns the same `Arc`; an out-of-range `i8` is refused by `validate`.
- **New `src-tauri/tests/audio_tonality.rs`**, reusing the synthetic 441 Hz region of `renderer.rs:2338-2417` and `frequency()` from `tests/audio_render.rs:67`: a shift of +12 doubles the measured frequency and -12 halves it; a percussion track is unchanged; sample selection uses the shifted key (a note shifted into another region plays that region).
- **Extensions:** `tests/audio_golpe.rs` (knocks unchanged at a shift); `tests/audio_midi_out.rs` (sent keys shifted, channel 10 not, held notes released on re-install); `tests/backing_processing.rs` (manual +3 with key -3 is exactly neutral, +12 with +12 measures the expected frequency and is finite, an extra of 0 is bit-identical to today, saved processing is unchanged); `tests/audio_practice_transport.rs` or `audio_transport.rs` (a `SetPractice` that changes only the shift reinstalls without changing tick, loop or generation, and the status echoes it; one that changes only speed does not reinstall).
- **TypeScript:** validation (integer, range, optional); `practiceForBacking` and `PracticePanel.apply` keep the shift (`src/audio/practice.test.ts`, `PracticePanel.test.tsx`); `practiceKey` acknowledgement; the Transport group's behaviour and `aria-disabled` focus rule (`src/Transport.test.tsx`); the CSS pins in `small-window.css.test.ts`; i18n parity for the new keys.
- **Export:** a MIDI export is byte-identical with the shift on, and an audio export at the saved key matches today's.
- **Desktop driver** (patterned on `tests/desktop/parity-practice.mjs`): raise the key while playing and check the status echo, the position and loop kept, no extra preparation, and that the score view is unchanged; open another document and see the reset. Check the transport at 960 by 600.
- **Only by ear or on real devices (not done by this work):** how the shifted recorded guitar and bass sound near the edges of their recorded range; backing quality beyond +-13; external MIDI hardware; other operating systems.

## Limits and non-goals

- Out-of-range recorded samples degrade by resampling; the guitar regions end at keys 40 and 86, so a shift of -12 on a low E (key 40) plays 12 semitones below the lowest region. Not judged by ear.
- The backing's effective shift can reach +-25 semitones, beyond the tested +-13.
- No per-track key shift (that is S21, track transposition) and no persistence of the shift across documents or restarts.
- The engraved score, tab numbers and instrument views are not changed.
- The metronome, Line-In and auditions are not shifted.
- A shift made during playback re-strikes held external MIDI notes.
- Not measured: the transport row width at 960 by 600, and the time a shift takes to apply on a large score.

## Slices

Each slice is implemented, reviewed and merged on its own.

1. **Native core.**
   - Files: `src-tauri/src/audio/practice.rs`, new `src-tauri/src/audio/tonality.rs`, `src-tauri/src/audio/mod.rs`, `src-tauri/src/audio/device.rs` (`SharedPractice`, `PreparedDocument::render_plan`, `command()`, `prepare_current`, `set_mix_inner`, `renderer_with_callback_frames`), `src-tauri/src/audio/backing.rs`, `src-tauri/src/audio/renderer.rs`, the 24 `PracticeSettings` literals (`device.rs`, `practice.rs` and eight files under `src-tauri/tests/`), and the Rust tests above.
   - Result: a shift sent through `setPractice` is applied, acknowledged and tested, with no UI.
2. **Front end.**
   - Files: `src/audio/practice-types.ts`, `practice.ts`, `PracticePanel.tsx`, `NativePlaybackController.ts`, `src/Transport.tsx`, `src/workstation/gp-shell.css`, `src/shell/small-window.css.test.ts`, `src/editor/command-palette.ts`, `src/audio/BackingProcessingControls.tsx`, `src/audio/MidiOutPanel.tsx`, `src/help/help-topics.ts`, `src/i18n/en.ts`, `et.ts`, `de.ts`, the TypeScript tests, a desktop driver, and a note in `docs/validation/` that updates the P12 and P20 rows only as far as the evidence goes (no GP8 runtime comparison, no ear check).

## Not in this work

- **Audio export "current key".** A `Key: Original | Current` choice beside `Speed: saved | current` in the export dialog, carried as an optional `tonality` on `AudioExportRequest` (`src-tauri/src/export/audio.rs:18-33`) with `#[serde(default)]`, applied through the same `transposed_plan` and the shifted backing install. Recorded as a possible follow-up; the exports stay in the original key until it is decided.
- Remembering the shift across documents or launches.
- Per-track key shifts.

## Implementation notes (slice 1, 2026-11-13)

The code forced these departures from the design above.

- **Channel 9 (section 2).** The design pins every plan note on channel 9. The renderer treats a channel-9 attack as a golpe knock only when no plan note owns it, and a plan note on channel 9 of a melodic track plays pitched. `transposed_plan` therefore moves every plan note of a melodic track and pins a channel-9 event only when no plan note pairs with it, using the renderer's own pairing key `(track, channel, key, tick)`; note-offs and note-bends follow their note-on.
- **Clamp collisions (section 2).** Two overlapping notes that clamp to one key would have the first note-off release the second. The earlier note now ends where the later starts (its pitch curve is cut to match), and a note that starts with a colliding one is dropped; a `legatoFrom` pointing at a dropped note is cleared. `noteBend` events of a shortened note after the cut, and all those of a dropped note, are removed with it.
- **Atomic key change (section 3).** The shift travels in `Install`, not in `SetPractice`: the callback's `SetPractice` keeps the shift it has, and a preserved `Install` adopts the one it carries on acceptance. `apply_key_shift` checks the queue has room for both commands before loading or building anything, then waits briefly (250 ms) for the callback's echo; if a newer preparation has overtaken the install it rolls back and returns an error. The echo is tested before supersession, so an install the callback already took is never reported as superseded. On timeout (a stalled callback) the document commits the shift, so a `SetPractice` is routed to `apply_key_shift` whenever its shift differs from the document's, or from the echo unless an install for that shift and generation is still outstanding (remembered on the control side, dropped when the echo shows it or the generation changes). That cap keeps a stalled callback from being asked to reload and rebuild for every practice send; the cost is that a lost install is recovered by sending a different shift, not the same one. The wait is a field of the shared status so tests can inject it; production keeps 250 ms. The rebuild does not store plug-in refusals (the plans are the document's own).
- **Backing (section 5).** The grain stretcher's search radius scales with the step, and out-of-range source frames read as silence, so no clamp of the 25-semitone total was needed; a +-25 case is tested for finiteness and pitch.

## Implementation notes (slice 2, 2026-11-13)

Built as the UI section says, with these decisions where it was silent or the code differed. No Rust changed in this slice.

- **Placement.** The `transport-key` group sits in the transport row after the speed group, with the compact caption of THE-196 (the group joined both `:is(...)` lists in `gp-shell.css` and the pins in `small-window.css.test.ts`). Whether the row fits at 960 by 600 was not measured here; the desktop driver `tests/desktop/parity-key-shift.mjs` measures it and fails if the group is outside the window or the transport overflows, in which case the group moves into "More playback".
- **Value shown.** The acknowledged shift (the echo), not the requested one. While a change is pending all three buttons are `aria-disabled`, the group carries `data-pending` and the existing "Applying practice settings" message shows; a button that holds focus keeps it. The value is formatted with `Intl.NumberFormat(lang,{signDisplay:'exceptZero'})`.
- **Refusal.** A shift that native refuses or reports superseded makes the controller raise a new notice, `key_shift_refused`, and the transport says "The key change was not applied. The key stays at {value}." (value is the acknowledged shift). The notice clears on the next practice request. The raw native error is still shown as before.
- **Between documents.** The shift is the session of one document, as the spec says: any change of document epoch resets practice to the default, so switching to another open document, and switching back, both start at the original key. Tested in `NativePlaybackController.test.ts`. A global shift was not chosen: it would need a second store beside speed's, and the owner decided the shift resets on a document change.
- **No shortcut.** Only command-palette entries (`keyLower`, `keyRaise`, `keyReset`), which click the transport buttons through `data-action`, so they follow the same pending and limit rules. Three new palette commands changed the pinned English orderings in `command-palette-order.test.ts` and the lists in `command-palette-i18n.test.ts`; those expectations were updated, nothing else about the ordering changed.
- **Hints.** `transport.key_hint` (session only; drums, click and score unchanged; exports keep the original key) is the group's accessible description and the value's title. It is true for a score with only percussion, where the shift moves just the backing. The backing and MIDI-out hints show only while the shift is not 0, through a `keyShift` prop that `App` reads from the playback state.
- **Help.** A "Change the key" section in the playback topic, found from the key group by the context map; the speed topic gains one sentence pointing to it.

### Review fixes to slice 2 (2026-11-13)

- **A key asked for just before an edit is not lost.** `beforeScoreChange` bumps the generation before native can answer, so a rejection of the pending key is dropped by the generation check. The controller now carries the requested key (pending or queued) across the score change and puts it in the next prepare's practice settings; a document change drops it.
- **Pending is bounded.** A practice request nobody acknowledges falls back, after 2.5 s (native waits 250 ms for the callback), to the acknowledged settings, shows the refusal notice (`key_shift_refused` for a key, the new `practice_unconfirmed` otherwise) and lets new requests through. A late echo of that request clears the notice. The old documented recovery (send a different shift) is no longer blocked by the pending guard.
- **Steps coalesce.** `setKeyShift(target)` and `stepKeyShift(delta)` are the controller's; while a request is pending, steps accumulate into one queued key sent when the pending one is acknowledged (never two in flight, always within -12..12). A refusal or timeout drops the queue. The transport's buttons stay available during pending, and their limits follow the key asked for (`keyTarget` in the state), so focus is kept.
- **The palette calls the same methods** (not a click on a button), and refuses what cannot run with a translated reason in its own status: not ready, at the limit, already the original key.
- **One translated message.** A refused shift no longer sets the raw native error; the visible message is a plain paragraph and a persistent polite live region announces it once. The same region announces each acknowledged change ("Key +3"); the value output stays silent, and the backing and MIDI-out hints are not live regions.
- **Draft kept, embedded backing, document switch.** The Practice panel's accepted-settings key no longer includes the shift, so a key step keeps an unapplied draft. An embedded backing (no processing controls) shows its own hint. On a change of document the controller resets practice before the idle state is built, so the old shift is never shown in the new document. The help says switching between open scores also resets.
- **Focus while the score is prepared.** The transport row is a fieldset that disables itself while not ready; while a key button holds focus the row stays enabled and the key buttons are only `aria-disabled`, so the focus is not dropped.
- **Narrow windows.** The row's width was not measured. At 1100 px and below (the toolbar's own breakpoint) the Key group is rendered inside More playback instead of in the row, so More playback cannot be pushed off the window; wider windows keep it in the row. The desktop driver checks every transport control's right edge, with a selection present, at 1280 and at 960 wide, and that the Key group is reachable at 960. If the row turns out to fit at 960, the breakpoint can be lowered.

### Second review fixes to slice 2 (2026-11-13)

- **Row stays disabled, key buttons live outside it.** The `focus-keeps-the-row-enabled` approach was wrong: with a key button focused it enabled Play, Stop, Loop and the speed buttons before the plan was prepared. The row is now a plain `div.transport-primary` holding a `fieldset.transport-fields` (play, position, loop, click and speed groups, disabled while not ready, as before), then the Key group, then More playback, so the key buttons are never natively disabled (they are `aria-disabled` while not ready) and nothing else wakes up. No focus state is kept, so nothing can stick.
- **Folded group stays visible and audible.** The polite announcement region is always mounted outside More playback. While the group is folded and the key is not 0, the summary carries `data-key` and a small "♮ +3" mark from CSS, so a shift made from the palette is visible. An announcement is made only for a change the player asked for (one that passed through pending), so a document switch to the original key is silent, and a repeated identical message alternates a zero-width mark so a screen reader says it again.
- **Focus across the breakpoint.** The narrow-window hook runs a callback before it flips; if a key button had focus the layout effect opens More playback and focuses the same button after the move.
- **Bound after the answer.** The 2.5 s wait for the echo starts when native has answered the command (native builds the renderer inside it), so a slow build is not reported as "not applied".
- **A refused carried key.** If the prepare after an edit fails with a carried key, it is retried once at the acknowledged key with the refusal notice.
- **Dropped steps, palette errors.** A refusal of another setting or a native status error that drops queued key steps raises the key notice. The palette's failure message is translated (`practiceProblem`), never a raw error.

### Final fixes to slice 2 (2026-11-13)

- **Nothing moves under the pointer.** The popover's top follows the height of the transient messages row, and every key change showed and hid "Applying practice settings…" there, so the folded buttons dropped and returned on each change and a quick double click gave one step. A pending change that is only a key change (`keyTarget` differs from the acknowledged key) is now shown inside the Key group (a visually hidden text plus the existing pending style) and no longer in the messages row; any other pending setting still uses the row.
- **The folded mark is an element.** `span.transport-keymark` (role img, label "Key +3" from `transport.key_announced` in en/et/de, compact visible text "♮ +3") in the More playback summary, which grows to hold it; the summary's name reads "More playback Key +3". The earlier CSS-generated mark is gone.
- **Carry and retry only a real change.** `beforeScoreChange` carries a key only when the requested key differs from the acknowledged one, so a pending speed change no longer causes a retry or a false notice.
- **Announce every acknowledged key change** except one that comes with a document switch. The controller exposes a `documentSerial` for that; a late echo after a timeout and a key carried over an edit are announced.
