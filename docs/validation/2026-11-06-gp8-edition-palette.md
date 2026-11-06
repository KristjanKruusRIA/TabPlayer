# Edition palette: Guitar Pro 8's controls (2026-11-06)

Branch `feature/palette-complete`, from `develop` at `c9172f7`. Linear: THE, project P-THE-2.

## Goal

The palette left of the score had only voices, durations, dots, rest, tie, dynamics, time signature, tempo and twelve note techniques. Guitar Pro 8's Edition palette also has bar, pitch, articulation, stroke, ornament, text and beaming controls. The user's two GP8 screenshots were the reference:
- the first shows most of GP8's controls greyed out because no note was selected;
- the second, with a note selected, shows them usable.

The rule for this slice is the same as GP8's. Each control either works, or is greyed out only when the current selection makes it meaningless. Each click is one undoable edit, and choosing the value already in place records nothing.

## What changed

- **`src/editor/palette-actions.ts`** (new) works out every new control for the cursor position: whether it is usable, whether it is highlighted, and the one edit a click makes. It reuses existing edit commands. The palette component only draws the controls.
- **`src/editor/EditingToolbar.tsx`** renders the new groups in GP8's order:
  1. voices, Lyrics, Chords;
  2. bar;
  3. durations, then dots, rest and tie;
  4. tuplets, grace notes and accidentals;
  5. dynamics, then hairpins;
  6. the existing techniques, then the new effects;
  7. chords, text and beaming;
  8. tempo.
- **Lists and prompts.**
  - Lists open as a full-width row under their button, so the scrolling palette cannot clip them: triplet feel, alternate endings, directions, tuplets, harmonics and whammy.
  - Arrow keys, Home and End move through a list. Escape closes it and returns focus to its button.
  - Text and Section ask for one line of text, and Apply makes one edit.
  - Buttons with a list or a prompt show a small corner mark, as GP8's do.
- **Lyrics** opens the inspector's Selection tab, switches it to the Staff scope, and opens and focuses the Lyrics section. **Chords** and **Chord diagram** open the chord dialog, and **Scale diagram** opens the scale browser. **Clef**, **Key signature** and **Time signature** open Measure & notation. **Tempo** moved to its own automation group at the end, as in GP8.
- **One new edit field:** `stringNumber` on `setNoteTechniques` / `setNoteTechniquesByIndex` shows a note's string number in a circle (alphaTab `showStringNumber`).
  - It is optional in TypeScript and in Rust (`edit_types.rs`).
  - Old `.tabplayer` projects and edit logs never carry it, so they replay unchanged.
  - Null and non-boolean values are refused.
- All new text is in `src/i18n`, with 118 keys each in `en`, `et` and `de`.
- While busy, palette buttons stay focusable with `aria-disabled` and ignore clicks, following `useBusyGuard`. On a locked score, edit buttons are disabled; buttons that only open a panel stay usable.

## Controls and when they are usable

| Group | Controls | Edit | Usable when |
|---|---|---|---|
| Bar | Clef, Key signature, Time signature | open Measure & notation | always |
| Bar | Triplet feel (list of 7) | `setMasterBarGestures` | always |
| Bar | Free time, Start repeat, End repeat, Alternate endings (1–8) | `setMeasureSettings` | the measure's tempo changes can be rewritten exactly (`measureSettingsExact`) |
| Bar | Double bar | `setMasterBarGestures` | always |
| Bar | Repeat previous bar or two bars | `setSimile` | enough earlier bars exist |
| Bar | Directions (19) | `setDirections` | always |
| Bar | 8va, 8vb, 15ma, 15mb | `setOttava` on the beat | a beat |
| Rhythm and pitch | Triplet, Tuplet list (2:3, 4:3, 5:4 … 13:8) | `setBeatRhythm` | a beat, and a lengthening tuplet still fits the bar |
| Rhythm and pitch | Fermata | `setFermata` | a regular beat |
| Rhythm and pitch | Grace note before / on the beat | `setBeatRhythm` | a sounding beat |
| Rhythm and pitch | Spell with 𝄫 ♭ ♮ ♯ 𝄪, Automatic spelling | `setNoteSpelling` | a note on a pitched staff |
| Rhythm and pitch | Move to higher / lower string | `moveSelectionStrings` | the adjacent string is free and keeps the pitch at fret 0 or above |
| Hairpins | Crescendo, Decrescendo | `setCrescendo` | adding: the beat is an attack, a later attack exists, and one dynamic step is in range; clearing: always clears the whole run |
| Effects | Heavy accent, Tenuto, Wide vibrato, Trill, mordents, turns | `setNoteTechniques` | a note (not percussion where pitch matters) |
| Effects | Slur | `setNoteLink` (slur) | a note with a later note, or an existing slur |
| Effects | Sustain pedal down / up | `setSustainPedal` | a regular beat on a pitched staff, where presses and releases still alternate |
| Effects | Dead slap, Tap, Slap, Pop, Golpe (thumb, finger), Wah open/closed | `setBeatGestures` | a sounding beat on a stringed staff |
| Effects | Whammy bar vibrato, Fade in/out, Volume swell | `setBeatGestures` | a sounding beat |
| Effects | Harmonics list (artificial, pinch, tap, semi, feedback) | `setNoteTechniques` | a stringed note |
| Effects | Whammy list (dive, dip, hold, pre-dive) | `setBeatTechniques` | a sounding beat on a stringed staff |
| Effects | Pick scrape down/up, slides in and out, Legato slide, Left-hand tapping, Show string number | `setNoteTechniques` | a stringed note (legato slide: a next note on the string) |
| Effects | Strum up/down, Arpeggio up/down, Downstroke, Upstroke | `setBeatTechniques` | a sounding beat on a stringed staff |
| Effects | Rasgueado | `setBeatGestures` | a chord on two or more strings |
| Effects | Tremolo picking | `setBeatTechniques` | a sounding beat with a valid tremolo speed |
| Chords, text, beaming | Chord diagram, Scale diagram | open dialog | a beat (chord), always (scale) |
| Chords, text, beaming | Slash notation, Show timer, Barre (at the lowest fretted note) | `setBeatGestures` | a beat (barre: a fretted stringed note) |
| Chords, text, beaming | Text, Section | `setBeatText`, `setMeasureSettings` | a beat; section like the other measure settings |
| Chords, text, beaming | Beaming (automatic, with next, break, break secondary), Stem (automatic, up, down, inverted) | `setBeatGestures` | a beat |

The earlier technique buttons (hammer/pull, slide, bend, vibrato, palm mute, let ring, dead, ghost, staccato, natural harmonic, accent) keep their labels and behaviour.

## Defects found while testing, fixed here

- alphaTab stores "no tuplet" as -1. Grace notes and the tuplet list first sent that value back, which the engine refused. The palette now sends 1:1.
- A simile mark needs one or two earlier bars. It was usable in bar 1 and failed there; it is now greyed out.
- Pedal up was offered where the pedal was not held, and pedal down where it already was. Both now follow the alternation the engine enforces.
- Duplets and quadruplets were offered in full bars that could not hold them. They are now greyed out.
- Opening a list wrapped its button in a new element, which remounted it and lost focus. Each control now keeps one stable wrapper.

## Evidence

- `npx tsc --noEmit -p .`: clean.
- **New tests** in `src/editor/palette-actions.test.ts` (8), on a real score of four two-string chords:
  - Every enabled control and list entry, more than 90 of them, produces one edit that `previewEdit` accepts.
  - 42 toggles are highlighted once applied, and a second click restores the off state.
  - Choosing the current value (stem, beaming, spelling, tuplet, triplet feel, harmonic, unchanged text) returns no edit.
  - The hairpin is added to the next attack and cleared over its whole run.
  - List entries produce the expected edits.
  - Panels open from their buttons.
  - Note effects are off without a note, and stringed-only effects are off on a percussion staff.
- **`src/editor/EditingToolbar.palette.test.tsx`**, 5 new tests:
  - one edit per click;
  - controls greyed out without a note;
  - the tuplet list by keyboard, with Escape returning focus;
  - the text prompt, where unchanged text records nothing;
  - Lyrics, Chords, Clef and Key opening their panels;
  - busy (focusable, ignored) and locked (edits disabled, opening still allowed).
- **`src/EditorPanel.test.tsx`:** a new test checks that the palette's Lyrics button reveals and focuses the Lyrics section, and that Chords and Scale diagram open their editors. The End-key check now lands on the palette's last control.
- **`src-tauri/tests/protocol.rs`:** `note_techniques_take_an_optional_string_number` checks that `stringNumber` round-trips, that an older patch without it reads and writes unchanged, and that null or a number is refused.
- **Vitest** (editor, i18n, EditorPanel, App, parity-commands, workstation): 1,294 passed and 2 failed. Both failures are the known load timeouts, App "passes canonical paper targets" and TrackSettingsPanel presets. Both pass alone.
- **Rust:** `cargo fmt --check` is clean, and `cargo test --locked --test protocol` passed 11 of 11. The full Rust suite was not rerun; the only Rust change is the optional field.

## Desktop check

- `scripts/build-desktop-test.ps1` was run on Windows, followed by the new driver `node tests/desktop/parity-edition-palette.mjs`. The driver opens a GP file with six-string chords and checks the following:
  - Heavy accent, Show string number, 8va, Strum down, the 5:4 tuplet from its list, and Text each ran as exactly one edit in the native document. This proves the native core accepts the new `stringNumber` field.
  - Show string number shows as pressed afterwards.
  - Ctrl+Z removed one edit.
  - The palette column does not scroll sideways, and there were no page errors.
- The driver passed on the final build.
- Screenshots `palette-before.png` and `palette-after.png` (test output, not committed) were checked by eye. That check led to these fixes:
  - long text glyphs ("0:00", "VVV") spilled into their neighbours; they are now smaller or replaced;
  - the mordent glyphs drew as "tr", which was the wrong codepoint;
  - the hairpins and music symbols (clef, repeats, fermata, accidentals) were too small to read.
- With a note imported from a GP file, its written accidental shows as pressed: the GP importer stores the written spelling, so this is the stored value, not a fault.

## Limits

- **Not covered:**
  - GP8's volume and pan automation buttons: TabPlayer has no volume or pan automation, and adding it needs playback work.
  - The multivoice editing toggle.
  - GP8's palette collapse button.
- **Voices:** a voice the bar does not have is still greyed out. GP8 always has four voices; adding one here takes a separate `addVoice`, so one click could not both add and select it.
- **Lists replace GP8 dialogs:**
  - Alternate endings, directions, triplet feel, harmonics, tuplets and whammy use short lists instead of GP8's dialogs.
  - Whammy offers four preset shapes; the bend and whammy curve editors remain in the inspector.
- **Fixed defaults:**
  - Rasgueado uses the "ii" pattern; other patterns remain in Beat notation.
  - Barre is a full barre at the lowest fretted note.
  - Tremolo picking takes the slowest valid speed.
  - The fermata is medium with length 1.
- **Hairpins from the palette** run from the cursor to the next attack and end one dynamic step further. Longer hairpins remain in Beat notation's range form.
- **Measure settings:** free time, repeats, endings and sections are greyed out when a measure's tempo changes cannot be rewritten exactly. This is the same limit as Measure & notation.
- **Glyphs:** controls use Unicode and short text, not GP8 artwork, so some differ from GP8's.
- Checked on Windows only; not on macOS or Linux; no original-GP8 side-by-side.
