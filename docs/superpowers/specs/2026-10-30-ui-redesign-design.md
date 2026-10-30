# TabPlayer UI redesign (2026-10-30)

The interface exposes the engine as forms: `SoundPanel` alone has 17 dropdowns and a stack of number fields. This redesign gives each job a surface shaped like the thing being worked on. Figma file: https://www.figma.com/design/pW28fEQw7WsTVh6SA0kPsv (AI directions, tokens, Knob, Pedal, Track row and Button). `docs/design/figma-screens.js` builds the Sound rig and Workspace screens; it has not run yet because the Starter plan's MCP call limit was reached.

## Main question per surface

- **Score:** what do I play next, and where am I?
- **Sound:** what does this track sound like, and how do I change it while hearing it?
- **Mixer:** how do the tracks balance?
- **Edit:** what is this note, and what can I do to it?

## Shell

- Title bar: name, menus, document tabs.
- View switch: Score, Sound, Mixer. It replaces the centre region only.
- Transport stays at the bottom in every view, so a player can loop a passage while changing the sound. This is the signature of the design.
- Left rail: tracks with name, current sound, mute and solo.

## Language

- **Type:** Instrument Sans for interface text, IBM Plex Mono for bars, times, BPM and values. Both are OFL and bundled for offline use.
- **Colour:** warm charcoal surfaces. Lime means playback and "on". Blue means edit selection. Tungsten is reserved for amp hardware. Tokens are in the Figma file under `TabPlayer`.
- **Shape:** 4px controls, 6px panels. Regions are separated by rules and alignment, not cards.
- **Hardware:** drawn in SVG, not bitmaps, so knobs rotate, it stays sharp, and the artwork is app-owned. AI images are direction only and never ship.

## Controls

- **Knob:** `role="slider"`. Vertical drag, arrow keys, wheel, double-click resets, and a typed value through its value readout.
- **Fader:** the same contract, on one axis.
- **Segmented:** a radio group for 2 to 6 options. It replaces dropdowns where all options fit.
- **Pedal:** select with a click, bypass with its footswitch, reorder by dragging. Keyboard: arrows move focus, Space bypasses, Alt+arrows reorder.
- **Sound row:** Hear previews, Enter applies. Preview must keep today's Keep and Cancel behaviour.

## Surfaces

| Surface | Today | New |
| --- | --- | --- |
| Sound | Dropdowns and number fields in the inspector | Full rig: chain strip, block stage, sound browser |
| Amp | Number fields | Faceplate with six knobs and a model segmented control |
| Cabinet | Dropdown | Speaker with the four real microphone placements as spots, model control, IR load |
| Pedals | Collapsed `details` | Each block has its own face and knobs in the stage |
| Graphic EQ | Ten number fields | Ten vertical faders with Flatten |
| Mixer | Sliders in a side rail | Channel strips with faders, pan knobs, mute, solo, focus |
| Transport | Text buttons and More menu | Icon transport, time and bar readouts, loop, metronome, count-in, speed |
| Tracks | Cards with sliders | Compact rows, with mix in the Mixer |
| Editing | Long inspector of panels | Glyph toolbar for duration and techniques, contextual inspector |
| Bends, tuning, chords | Fields | Graph, string pegs, diagram |
| Dialogs | Stacked fields | Shared dialog frame and Segmented controls |

## Rules from the engine

Show only what exists. The microphone has four placements, not an X and Y position. There is no tuner, CPU meter or home screen. A control with no engine behind it is not added.

Every existing feature stays reachable. Accessible names stay the same wherever the control keeps its meaning, because tests and desktop drivers find controls by them. A control that changes role, such as a dropdown becoming a radio group, updates its tests in the same change.

Practice comes first on any window down to 960 by 600. The rig must work there; the browser collapses before the stage does.

## Delivery

1. Foundation: fonts, tokens, Knob, Fader, Segmented, shared Dialog.
2. Sound rig.
3. Shell, view switch and transport.
4. Mixer and tracks.
5. Editing toolbar and contextual inspector.
6. Dialogs and remaining panels.

Each phase passes `tsc`, Vitest, its desktop drivers and a rendered screenshot check before the next starts.
