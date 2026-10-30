# S22, S23: track interpretation

Date: 2026-10-24. Status: design. Rows S22 ("Playing style pick/fingers/picking/slap") and S23 ("Track interpretation intensity and automatic articulation") stay at their current status until the source review, automated checks and one desktop run pass.

## Brief

GP8's track interpretation settings change how a track is performed without changing what is written. TabPlayer infers one articulation per note (`articulation()` in `src/audio/plan.ts`: palm mute, dead, ghost, staccato, tap, harmonic, legato, pick stroke, right-hand finger, then the instrument's program) and has no way to steer it. This slice adds per-track settings, applied while the playback plan is built, so the native player and audio export hear them and the score is never rewritten. It works in `src/audio` only; no native audio file changes.

## Settings

Each is optional, absent at its default, and applies to **stringed** notes only (percussion and keyboard notes plan as before).

| Setting | Values | Effect on the plan |
|---|---|---|
| Playing style | automatic, `pick`, `fingers` | Replaces only the *default* articulation: `picked` or `fingered` for unmarked notes. |
| Palm mute intensity | normal, `light`, `heavy` | Palm-muted notes: `light` plays the looser, brighter `staccato` voice instead of `muted`; `heavy` keeps `muted` at 80% velocity. |
| Strong-beat accent | off, `light`, `strong` | Adds 10 / 22 velocity to notes on the bar's downbeat, and half of that on the middle strong beat (beat 3 of 4/4; each dotted-quarter group of 6/8, 9/8, 12/8). Beats are counted from their written start, within 7 ticks (tuplet rounding), so a grace note neither takes the accent nor moves it; a pickup bar is right-aligned; only the first attack of a trill or tremolo is accented. Ghost and dead notes are not accented. |
| Automatic let ring | off, on | Every plucked note rings until the same string is plucked again or its bar occurrence ends. Palm-muted, dead, ghost and staccato notes do not ring. |
| Automatic brush | off, `down`, `up` | A chord of two or more notes is spread 30 ticks apart (less for short notes, never past half the shortest note): `down` from the lowest pitch, `up` from the highest. |

### Overrides

A written mark always wins over the track's setting:

- Style: dead, palm-muted, ghost, staccato, tapped, harmonic and legato notes keep their articulation; a written pick stroke stays `picked` and a written right-hand finger stays `fingered`, whatever the style; a written slap or pop plays as before.
- Brush: a beat with a written brush, a pick stroke, a rasgueado, a dead-slap, a bend, or a trill/tremolo is left alone.
- Let ring: only extends a note; a note already ringing longer (written let ring, ties) is unchanged.

### Not offered, and why

- **Picking** (fingerstyle picking) would route to the same `fingered` voice as **Fingers**, so it would be a control with no distinct sound. Not shipped.
- **Slap** has no voice to route to: the native player has no slap articulation or samples, and adding one means changing `src-tauri/src/audio`, which this slice must not. Not shipped; a written slap plays as before.

Both belong with the native voice work. Recorded as limits of S22.

## Storage and replay

Settings live on the track's mix (`ChannelMix.interpretation`), the existing per-track document setting. Setting them is the existing `setTrackMix` edit, so there is **no new command**, `tests/protocol.json` keeps its count, and undo, redo, replay, finalized documents (mix edits stay allowed there, as the mixer is) and duplicated tracks (the mix is copied) work unchanged. A mix without the key is exactly today's mix, so projects and plans are byte-identical until a setting is chosen.

- Schemas: TypeScript `ChannelMix` and `validateMix` (unknown mix keys are now refused, as Rust already did); Rust `ChannelMix`/`TrackInterpretation` with `deny_unknown_fields`. Both refuse an empty object, an unknown value, `letRing: false`, and an interpretation on the backing track's mix. The Rust project and library index read edits as commands, so no further schema holds the field.
- Rust only stores and validates the field; the plan is built in TypeScript.

## Where it applies

`buildPlaybackPlanFromJson(json, identities, generation, interpretations?)` takes the map by track identity. `NativePlaybackController` passes the saved interpretations and, when they change, prepares a new plan (like a change of reference timing); a plain mix change still only calls `setMix`. Audio export passes the frozen document's. The plan worker carries the map. MIDI export and the backing-sync timeline use the written plan.

## UI

An **Interpretation** section under the Sound pane for stringed tracks: Playing style, Palm mute intensity, Strong-beat accent and Automatic brush selects, and an Automatic let ring checkbox. Each change is one `setTrackMix` edit. It is disabled while controls are busy, and hidden for tracks without strings.

## Acceptance

- **Unit tests** (`interpretation.test.ts`, `InterpretationPanel.test.tsx`, Rust `protocol.rs`):
  - plans are `JSON`-identical with no, empty, or other-track interpretations;
  - style routing for guitar and bass with every override;
  - palm mute light and heavy; accents in 4/4, 3/4 and compound meters;
  - brush down and up, written brush untouched, MIDI events agree with plan notes;
  - let ring to the next pluck, to the bar end, not through a mute;
  - eight settings give eight distinct plans, the score JSON is unchanged, and clearing restores the plan;
  - strict validation in TypeScript and Rust; the controller re-plans on a change but not on a gain change; a duplicated track copies the settings.
- **Desktop** (`tests/desktop/parity-track-interpretation.mjs`): each setting is one undoable `setTrackMix` edit; the WAV export of each setting differs from the default and from the others; let ring sustains, a heavy mute is softer, a strong accent is louder; clearing returns the default export byte for byte; only mix edits were made.

## Limits

- Changing a setting prepares a new plan, so playback stops and any loop or range is cleared (the panel says so). Keeping them across a re-plan would need the native player to swap plans in place.
- Audition (the tone heard while editing) follows the playing style, through the mix it is sent with; it does not apply accent, palm mute intensity, let ring or brush, which shape a whole passage.
- The instrument view's "next" focus treats a brushed chord as one onset, counted from the earliest first attack of its beat.

## Scope

- No Guitar Pro file persistence: GP8 stores these in its own track data, which alphaTab does not read, so they are TabPlayer project settings.
- No new native voices, so no picking or slap sounds.
- No per-bar or per-beat interpretation.
