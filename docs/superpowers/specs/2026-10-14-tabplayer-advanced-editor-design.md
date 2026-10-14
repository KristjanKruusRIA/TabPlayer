# TabPlayer advanced editor

Date: 2026-10-14. Status: written specification awaiting user review. Shared requirements: [expansion specification](2026-10-14-tabplayer-deferred-features-design.md).

## Behavior

Keep the approved toolbar, track panel, score and inspector arrangement. Add inspector sections for notes/techniques, rhythm, measure and staff/voices, with a curve editor for bends/whammy and a chord dialog. Selecting an existing note populates its current values; changing another string selects that note independently. Chord-wide operations must be explicitly chosen. Controls have accessible names and keyboard operation. Invalid targets and parameters produce the existing inline error, create no history entry and preserve the selection.

Existing tracks gain editable full/short names and the complete General MIDI program list (0–127 in the persisted protocol, human-readable names in the UI). Retuning, capo and sounding/display transposition are separate settings. Instrument changes preserve notes, tuning, track identity and mixer settings; playback regeneration uses the new program for automatic sound selection. An explicitly chosen recorded-voice override remains visible and independent of the MIDI program. Imported percussion remains playable and retains its metadata.

## E1 Technique coverage

Expose creation, modification and removal of every family in this table through finite typed commands, using public alphaTab fields and enums. Imported values remain inspectable. A technique command targets the selected beat and string; beat techniques target the whole beat.

| Family | Editable values and musical rule |
| --- | --- |
| Sustain and attack | Let ring, palm mute, dead note, ghost note, staccato, accents/tenuto, dynamics, left/right-hand fingering, left-hand tapping and pick stroke |
| Ties | Create a tie to the next same-string, same-pitch note in the voice; break the incoming or outgoing tie. Editing a tied pitch retains the existing whole-chain behavior until explicitly broken |
| Hammer/pull and slurs | Create/remove same-string hammer-on/pull-off to the next pitched note; create/remove a slur between explicitly selected notes in the same staff/voice. Validate forward order and repair both relationship ends |
| Slides | All public slide-in/slide-out modes, including shift, legato and pick slides; linked slides require a valid next note on the same string |
| Pitch curves | Bend/prebend/release/custom points, bend style, whammy-bar type/style/points and slight/wide vibrato. Curve positions use alphaTab's 0–60 axis and quarter-tone values; sorted finite points include endpoints. Whammy curves permit negative pitch displacement |
| Harmonics | Natural, artificial, pinch, tap, semi and feedback harmonic types and harmonic value; validation checks the resulting playable pitch |
| Repetition and decoration | Trill pitch/speed, tremolo-picking speed/style, ornaments, brush/arpeggio direction and duration |

Clearing a technique clears its associated curve or relationship data. Rest conversion and note/beat/measure/staff/voice deletion unlink ties, slurs, slides and hammer/pull relationships at both ends. Copying music reconstructs relationships within the copied range and never creates links back into its source. Multi-string bends must retain independent pitch curves; channel-wide bend behavior is insufficient for the native guitar engine.

## E2 Voices and staff layout

Support one to four voices per bar, consistent across every bar of a staff. Add/remove a voice for the entire staff; retain at least one voice. An added voice starts empty, not as audible rests that extend a measure. Copy a source voice into another voice for a chosen inclusive measure range as one undoable command. Copying replaces that range only after validating capacity and relationships. Deleting a voice repairs active selection and loop endpoints.

Allow adding/removing staves within a track, retaining at least one. Added staves have explicit tuning/clef settings and aligned empty bars. Provide standard-notation/tab visibility, clef, tuning, capo and transposition settings per staff. Permit per-track system breaks and bars-per-system layout; keep screen zoom independent of persisted notation layout. Staff and voice edits cannot change another track's notes.

## E3 Notation and rhythm

Support all pinned public duration values: quadruple/double whole and 1, 2, 4, 8, 16, 32, 64, 128 and 256, plus 0–3 dots. Retain the verified triple-dot timing correction for every relevant edit/rebuild. Tuplets use positive integer numerator/denominator and capacity is calculated from actual playback durations. Expose normal/on-beat/before-beat/bend-grace types; grace beats do not independently overfill the host measure. Normal notes, explicit rests, full-measure rests and empty voice carriers remain distinct.

Measure controls edit time-signature numerator and power-of-two denominator, pickup/free-time state, repeat start/end/count, alternate endings, section label, and ordered tempo changes at beat positions. Changing meter validates every staff/voice in that measure before commit; reject overflow rather than deleting music. Underfilled measures stay editable. Tempo changes are positive finite BPM; repeated occurrences use the generated playback ordering. Meter changes and pickup durations affect seek/loop/export and the metronome consistently.

Expose per-bar key signature/mode and clef, beat text and chord names/diagrams. Chord definitions store their name, first fret and per-string fret/open/mute positions through the public staff chord model. Import/replay retains unsupported source data in the immutable base. General-purpose access to arbitrary model properties is not part of the command protocol.

## E5 Selection correction

Measure/beat/staff/voice/string inputs accept whole numbers. Empty drafts remain editable without changing selection. Fractions, non-finite values and out-of-range values cannot escape as an uncaught event-handler error. Commit a valid whole-number value through one selection-normalization path. Structural edits clamp to an existing track/staff/bar/voice and either an existing beat or the explicit empty-voice insertion location. Undo, redo and document replacement refresh the displayed fret and technique controls even when numerical indices did not change.

## Architecture and acceptance

Extend matching Rust/TypeScript command definitions with named, validated payloads for technique, rhythm, measure, track, staff/voice and notation operations. The engine adapter applies candidate commands, rebuilds derived relationships and validates capacity before Rust commits. Use a compound command only for genuinely single user actions such as a voice-range copy. No permanent vendor JSON, private engine APIs or vendor-file patches.

For each technique family, tests cover authored music, removal, malformed parameters, linked-note deletion and undo/redo/save/reopen. Render fixtures verify visible technique/notation symbols, and MIDI/native-plan tests verify sounding pitch, envelope/articulation and timing where applicable. Record .gp exporter coverage per field, especially bends; native project persistence must retain every new editable field even if interchange omits one.

Multi-voice/staff tests include empty bars, different rhythm grids, compound meter, repeats and cross-bar ties. Track tests use existing imported tracks, stable identity through deletion/undo and a program change with distinct audible timbre. A native smoke test performs these edits on an authorized GP file, saves/restarts/reopens and confirms original hashes. Keep the existing rapid-deletion, triple-dot and mixer regression coverage. Record 100-bar/four-track timings after the expansion and resolve stalls that obstruct normal editing.

Public API evidence is the installed alphaTab 1.8.4 declaration/source and [score model documentation](https://alphatab.net/docs/reference/score). Every command must have a named test; the implementation plan will map each table family to exact commands/files/tests.
