# GP8 parity T27: sustain pedal press and release (2026-10-22)

GP8 lets users write sustain-pedal presses (`Ped.`) and releases (`*`) that print in the score and hold notes in playback. This slice adds the replayed edit command `setSustainPedal {target, pedal}`, where `pedal` is `down`, `up` or `none`. It was implemented on branch `feat/gp8-parity`.

## Behavior
- **Engine (`src/editor/sustain-pedal.ts`):**
  - Marks the pedal at the selected beat's position in its bar, on that staff.
  - Presses and releases always alternate:
    - a press before a later press extends that span;
    - a release before a later release shortens it;
    - clearing a mark also removes the mark that answered it.
  - Redundant presses or releases, clearing an unmarked beat, grace beats, invalid positions and percussion staves are refused, and nothing changes.
  - Replay rebuilds the score before applying, so a pedal written after a rhythm edit lands on the beat that replay produces. Undo replays the shorter history.
- **Rendering and GP:**
  - alphaTab draws `Ped.`, `*` and the pedal line, and derives hold markers for bars the pedal spans.
  - alphaTab's `Bar.finish` turns a re-press inside a bar entered with the pedal held into a hold. That would drop the re-press from print and GP export, so every rebuild restores it (`repairPedalPresses` in `scoreFromJson`).
  - GP export writes the presses and releases as `SustainPedal` automations, and they re-import exactly.
  - MusicXML export refuses scores with pedal marks with a clear error.
- **Audio and MIDI (`src/interchange/automation.ts`):**
  - Presses and releases become CC64 127/0 on the track's channels, in the native playback plan and in MIDI export.
  - The first performed bar and every repeat jump restate the pedal state, unless a mark starts that bar.
  - A track's staves share its channels, so they are merged into one pedal lane: the pedal is down while any staff holds it.
  - The native renderer already holds notes while CC64 is down.
- **Validation:** TS and Rust (`EditCommand::SetSustainPedal`, protocol example 72) accept only `down`, `up` and `none`, and refuse a missing value, `null` or extra fields.
- **UI:**
  - Beat notation → Sustain pedal shows the mark at the selected beat: No mark, Press (Ped.) or Release (*).
  - Apply sustain pedal is enabled only when the choice differs from the current mark.

## Evidence
- **Frontend:**
  - `gestures.test.ts`:
    - press, release and derived holds;
    - refusals that leave the score unchanged;
    - GP round trip;
    - span extension and clearing;
    - percussion refusal.
  - `engine.test.ts`, "sustain pedal marks":
    - engine replay, and Undo by the shorter history;
    - a pedal after a rhythm edit, at ratio 0.125;
    - a re-press after a release inside a held bar, through rebuild, GP re-import and exactly three GPIF pedal automations.
  - `automation.test.ts`:
    - CC64 on both channels with repeat-jump restates;
    - two staves merged into one lane.
  - `GesturePanel.test.tsx` and `notation-commands.test.ts`.
  - RED log: `.analysis/parity/sustain-pedal-red.log`. It includes the engine-dispatch test that failed before `advanced.ts` routed the command.
  - **Mutation checks:** removing the press repair, removing the replay rebuild, or keeping a single staff lane each fails its test.
- **Native:** `tests/protocol.rs` round-trips 72 examples and refuses invalid pedal values. `cargo test --lib` passes (269).
- **Desktop (Windows desktop-test build):** `tests/desktop/parity-sustain-pedal.mjs` opens the four-track fixture, selects Keys, presses the pedal on measure 2 beat 1 and releases it on beat 3. It asserts:
  - the two recorded edits;
  - that an Export score → MIDI file contains CC64 0 at the start, then 127 and 0 2880 ticks apart, on both Keys channels;
  - that two Undos clear the marks;
  - that there are no page errors.
- **Review:** an Opus adversarial review found these issues, all fixed with tests:
  - a stale replay position after rhythm edits;
  - re-presses lost to alphaTab's hold conversion;
  - conflicting CC64 from two staves;
  - per-bar recomputation;
  - no percussion guard.

## Limits
- T27 is partial:
  - Pedal marks are stored by ratio, so a later rhythm change can leave a mark between beats, where the panel can't clear it.
  - Pickup bars use the pickup-aware bar length, while MusicXML import and paste use the full meter, so imported pickup pedals may not line up with a beat.
- GP stores pedals per track, and alphaTab re-imports them on the first staff, so a second staff's pedal merges into the first on round trip.
- Alternate endings restate the pedal from score order, as alphaTab prints it, rather than from the performed path.
- There are no half-pedal or sostenuto marks, and no original-GP8 comparison.
- The first pedal edit on an imported staff drops redundant imported presses.
