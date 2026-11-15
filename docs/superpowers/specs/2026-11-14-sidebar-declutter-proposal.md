# Sidebar declutter: proposal for approval (THE-215)

Status: **proposal, nothing in Part 2 is built.** Part 1 (the Track tab's tuning row and Tuning dialog, and the track action row) is built and recorded in `docs/validation/2026-11-14-the-215-tuning-popup.md`.

Owner's complaint: the sidebars have too many options and take up too much space. Direction: follow Guitar Pro 8's layout, styled as TabPlayer, with our own components, colours, icons and words.

## How this was measured

- Real app (desktop test build of this branch), default window 1440 x 900, inspector 304 px wide, inspector pane 510 px tall, collapsed sections closed, a three-track guitar/bass score. `tests/desktop/inspector-inventory.mjs` lists every control and each tab's content height.
- "Frequency" is my judgement of how often a guitar or bass player practising or lightly editing needs the control. It is not usage data.
- "Guitar Pro 8" is from general knowledge of the product plus the layout reference pictures the owner supplied. Where I name a reference, I give a short description, not a file name.
- Heights marked *est.* are estimates. "Before" for the Track tab is derived: the old tuning stack was measured in the Add instrument section (preset 48 px, field with headstock, steppers, saved tunings and play buttons 366 px, Keep pitch about 22 px, Apply 28 px, four stacked action buttons about 130 px).

## Headline recommendations

1. **Song tab: keep Information, Musical notation and Sound mastering; move the 13 score-style sections (Engraving, Staff profiles, Stylesheet, Notation, Typography, presets, saved styles, Design x3, Page layout, Default view) into one "Score style..." popup** opened by the Stylesheet "Open..." button, as Guitar Pro does.
2. **Track tab: follow the Guitar Pro order** (Information, Musical notation with one Tuning row, Sounds, Interpretation). Collapse the 20 effect pedal rows into the Guitar Pro "effect strip" with a "Show pedalboard..." popup. Put MIDI output and Add instrument behind menus.
3. **One tuning editor everywhere.** Add instrument already uses the Tuning dialog built in Part 1. The Selection tab's Staff tuning (a second copy of the old tuning stack, inside the staff settings form) should follow, together with capo, partial capo and the banjo drone.
4. **Every "Apply ..." button is a smell.** Of the 34 Apply, Save and Update buttons (Song 9, Track 5, Selection 20), most can become apply-on-change (one undoable edit per gesture, as the rules already require for steppers) or live inside a dialog that has Cancel.

## Heights at the default window (inspector 304 px wide)

| Tab | Before this branch (*est.* for Track) | Now (measured) | After this proposal (*est.*) |
|---|---|---|---|
| Song | 1066 px | 1066 px | about 380 px (Information with More, Concert tone, Stylesheet Open..., 3 mastering slots) |
| Track | about 3170 px | 2628 px | about 800 px (Information 70, Notation and Tuning 110, Sounds 200, Interpretation 330, MIDI output in a menu) |
| Selection | 3338 px | 3338 px | tab removed if the owner agrees (contents go to palette, menus and popups); if kept as a small strip, about 300 px |

The pane shows 510 px, so Song then fits without scrolling and Track needs about one and a half screens instead of five.

## Part 1 result, for the record

| Item | Before | After |
|---|---|---|
| Track actions | four full-width buttons, about 130 px | one row of four 28 px icon buttons with names and tooltips, Remove set apart on the right in the error colour, about 36 px |
| Tuning | preset select, notes field, headstock with six pegs, six steppers, Saved tunings, six note buttons, Play tuning, Keep pitch, Apply tuning: about 500 px | one row (Tuning, notes button, play), about 44 px; everything else in the Tuning dialog |

## Inventory: Song tab

Reference column: "GP song" = the Guitar Pro Song inspector (Information with More, Musical notation with Concert tone and Stylesheet Open..., Sound mastering with three slots and Show Pedalboard...).

| Control | Frequency (my judgement) | Guitar Pro 8 (general knowledge and reference) | Recommendation |
|---|---|---|---|
| Title, Artist | Medium: set once per score | Two fields at the top, Ctrl+Return for a new line (GP song) | **Stay** |
| Initial tempo | Medium | Tempo is on the toolbar and in the bar, not the Song tab | **Remove as duplicate** of the transport/measure tempo; keep one place |
| Apply score info | n/a | None: fields apply on change | **Remove** (apply on change) |
| Song metadata (subtitle, album, words, music, copyright, transcriber, notices, instructions, Apply) | Low | Same nine fields behind **More** (GP song) | **Collapse** behind "More", closed by default; drop Apply |
| New score defaults (default artist, authors, copyright, Use this score's details, Save defaults) | Very low | Preferences | **Move to menu** (Preferences) |
| Engraving (system spacing, Apply, Reset) | Low | Stylesheet dialog | **Move to popup** (Score style...) |
| Staff profiles (per-track notation profile) | Low | Track notation toggles plus stylesheet | **Move to popup** |
| Stylesheet (about 18 controls: dynamics, bar lines, system separators, tuning display, empty staves, brackets, track names ...) | Low | Stylesheet dialog opened from "Open..." (GP song) | **Move to popup**, and add the "Open..." button here |
| Notation (tab rhythm, fingering, grace notes, bend and line-effect options) | Low | Stylesheet dialog | **Move to popup** |
| Typography (46 controls) | Very low | Stylesheet dialog (fonts) | **Move to popup** |
| Notation style presets, Saved styles (8) | Very low | Stylesheet presets inside the dialog | **Move to popup** |
| Design: bar widths, system gaps, staff groups | Very low | Done by dragging on the score and in the Page/Stylesheet dialog | **Move to popup** |
| Page layout (32) | Low (printing) | Page Setup dialog (File menu) | **Move to menu** (File > Page setup...) |
| Default view | Low | View menu | **Move to menu** (View) |
| Concert tone | Low | Toggle in the Song tab (GP song) | **Stay**, if we have the feature; I did not find a concert-tone switch in the Song tab, so confirm before adding |
| Sound mastering: Master level, balance, Reset | Medium | Master volume is on the bottom track strip | **Stay** only as three effect slots; level lives in the track strip |
| Compressor, EQ, Reverb, Limiter (24 controls) | Low | Three mastering slots with a power button and a menu each, and "Show Pedalboard..." (GP mastering) | **Collapse** into three slot rows; full controls in a "Show pedalboard..." popup |

## Inventory: Track tab

Reference: "GP track" = Guitar Pro Track inspector (INFORMATION row: colour, icon, name, short name; MUSICAL NOTATION: notation toggles, one Tuning row, More; SOUNDS: RSE/MIDI switch, one sound row with an effect strip; INTERPRETATION: playing style, palm mute, accentuation, auto let ring, auto brush, stringed). "GP tuning" = the single tuning row and its dialog.

| Control | Frequency | Guitar Pro 8 | Recommendation |
|---|---|---|---|
| Track name heading | High | Name field in INFORMATION (GP track) | **Stay**, but make it the editable name field |
| Move up, Move down, Duplicate, Remove | Low to medium | Track menu and the track list in the bottom dock | **Done**: one icon row (Part 1). Consider also dropping Move up/down here, since the dock already reorders |
| Selected instrument: name, short name, MIDI instrument, colour, Apply x2 | Medium | Colour swatch, instrument icon, name, short name in one row (GP track) | **Stay** as one row (colour, name, short name), apply on change; MIDI program moves to the MIDI sound view |
| Tuning row | High | One row: cog button with note letters, play button (GP tuning) | **Done** (Part 1) |
| Tuning dialog | Medium | Library row, Strings line, one row per string with stepper and play, shift all, alteration, Capo, Display label, Keep the Fingering / Cancel / Adjust the Fingering (GP tuning dialog) | **Done** for library, strings, per-string rows and play, and Keep fingering / Cancel / Keep pitch. Capo, partial capo and the banjo drone exist today in the Selection tab's Staff panel: add them to this dialog in a later slice. Not added: shift-all, flat/sharp display, display label |
| Add instrument (name, MIDI instrument, tuning stack of 24 controls, Add track) | Low | Track > Add track dialog | **Move to menu**: Track > Add track... using the Tuning dialog |
| New notation track, Add pitched track, Add percussion track | Low | Track > Add track dialog | **Move to menu**, same dialog |
| Sound: Lock sound, Sound source, preset, Restore, Factory sound, Apply, Preview, Copy, Paste, Saved sound, Apply saved, Delete saved, name, Save (17) | Medium | One sound row with a menu and an effect strip (GP track) | **Collapse** into one sound row (source, preset, menu for save, copy, paste, lock) |
| VST3 plug-in | Low | Sound menu | **Move to menu** (the sound row's menu) |
| 20 pedal rows (Microphone, Gate, Compressor, Wah, Octaver, Pitch, Drive, Amp, Cabinet, EQ, Graphic EQ, Vibrato, Phaser, Flanger, Chorus, Tremolo, Delay, Reverb ...) each with enable, move earlier/later, copy, paste, duplicate and parameters | Low | Small effect strip under the sound row plus a "Show pedalboard..." popup (GP track; GP mastering) | **Move to popup**: effect strip of enable icons in the sidebar, pedalboard in a popup. This is the biggest single saving (about 1100 px) |
| Interpretation: playing style, palm mute, strong-beat accent, automatic brush, automatic let ring | Medium | Same five, with sliders and switches (GP track) | **Stay**, restyled as in the reference (label left, control right, no Apply) |
| MIDI output (port, Refresh) | Very low | MIDI tab of the Sounds block | **Move to menu**/popup (Sound menu) |
| Notation toggles (tab, standard notation, slash, numbered) | Medium | Four toggle buttons beside "Notation:" (GP track) | **Add** as a row; today these are per-staff checkboxes in the Selection tab |
| Transposition and octave | Low | "C played as" and "Octave" under More (GP track) | **Collapse** behind More |

## Inventory: Selection tab

Reference: "GP palette" = Guitar Pro's left palette (notes, rhythm, effects, bar, notation, dynamics) and its menus. Our left palette and Edit menu already hold most of these.

| Control | Frequency | Guitar Pro 8 | Recommendation |
|---|---|---|---|
| Edit: All/Note/Beat/Measure scope, Measure, Beat, Staff, Voice, String selectors, Fret, Set note | High while editing | Click the score; no location form | **Stay** as a compact status line ("Bar 3, beat 2, string 4"); drop the selector form |
| Advanced rhythm (tuplet numerator, denominator, grace type) | Low | Palette tuplet and grace buttons | **Remove as duplicate** of the palette |
| Notes and techniques (let ring, palm mute, dead, ghost, staccato, tapping, accent, dynamics, length, offset, velocity, finger: 36) | High | Palette note effects and dynamics (GP palette) | **Remove as duplicate** of the palette; keep the numeric note-audio values (length, offset, velocity) in one popup |
| Bend curve, Whammy curve | Medium | Bend/whammy editor popup from the palette | **Move to popup** |
| Explicit slur destination | Very low | Palette slur | **Move to popup** |
| Beat notation (tap, slap, pop, golpe, rasgueado, fade, vibrato, wah, stem direction, beaming: 29) | Low | Palette and Beat menu | **Move to menu** |
| Music selection (Select bar/track/all, scope, erase, tie, transpose by semitone/octave: 37) | Medium | Edit menu and shortcuts | **Move to menu** |
| Standard notation entry (key signature, accidentals, octave) | Medium for notation users | Palette notation row (accidentals, key) (GP palette) | **Remove as duplicate** of the palette |
| Musical clipboard (copy/cut mode, copy, cut, paste) | Medium | Edit menu | **Move to menu** |
| Sections, Score errors | Low | Section menu; error marks on the score | **Move to menu** |
| Harmony transposition | Low | Tools menu | **Move to menu** |
| Beat text | Low | Palette text button | **Move to popup** |
| Measure and notation (time, pickup, free time, repeats, endings: 28), Directions (21), Bar gestures (12), Insert and remove measures (7) | Low to medium | Palette bar row and Bar menu (GP palette: bar row) | **Move to menu** (Bar), repeat and ending buttons stay in the palette |
| Staff, voices and layout (58, includes a second copy of the tuning stack, capo, clef, partial capo, drone, tab/notation toggles, staff add) | Low | Track inspector notation row, tuning dialog Capo section | **Move to popup**: the Tuning dialog (tuning, capo, partial capo, drone) and the Track notation toggles |
| Lyrics (visible, Add line, Apply) | Low | Lyrics tab on the left | **Remove as duplicate** of the left Lyrics tab |

## Left sidebar and dock

The left rail (voices 1-4, Lyrics, Chords, the palette) and the bottom dock (Overview, Mixer, Instrument, Keyboard, Backing) were not inventoried control by control. They look like the Guitar Pro layout already and I found no clutter there. The dock's Overview and Mixer rows duplicate Volume and Pan with the Track tab's header: keep the dock rows only.

## Suggested order of work

1. Track tab: Information row, notation toggles, effect strip with pedalboard popup (largest saving, one tab).
2. Song tab: Score style... popup.
3. Selection tab, if the owner agrees (see the first decision below): remove duplicates of the palette, move the rest to menus and popups, one slice per group.
4. Move the Selection tab's Staff tuning into the Tuning dialog and add capo, partial capo and the banjo drone to it. Add track already uses the dialog.

## Decisions I need from the owner

- Remove the Selection tab, or keep a small strip for the cursor location and note values? Guitar Pro's inspector has only Song and Track; what we put under Selection is what Guitar Pro puts in the left palette, the menus and a few popups, and most of the tab's 95 visible controls (310 in all) duplicate our palette.
- Is the Tuning dialog's default button right? Today **Keep fingering** (fret numbers stay, notes sound different) is the default, as the old Apply was. Guitar Pro defaults to the other one (adjust the fingering, equal to our Keep pitch).
- Tuning is shown high to low everywhere in the app, so the sidebar row reads "E4 B3 G3 D3 A2 E2". Guitar Pro's short row shows low to high letters. Switch the sidebar row and the dialog's notes line to low to high?
