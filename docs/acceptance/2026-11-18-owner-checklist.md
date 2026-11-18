# Owner checklist for the tickets in review - 2026-11-18

For the build from `develop` at `b57c819` (installer 1.0.0, MSI). Each line is one thing to try and the ticket it closes. Nothing here
has been tried or heard by a person yet. A ticket can be closed when its lines pass; anything that fails goes back on the ticket as a
comment.

Use one of your own scores unless a line says otherwise.

## Editing and interface

| Ticket | Try | Passes when |
|---|---|---|
| THE-213 | Drag Volume and Pan in a track row; type fret digits on the tab; edit notes on your largest score | The sliders follow the pointer and one undo reverts one drag; a digit writes at once and two quick digits make one fret; an edit feels immediate |
| THE-213 | Move a track up or down, or drag its grip in the dock overview | Each row still has one fader and one pan knob (this was broken in the earlier installer) |
| THE-215 | Open the Song and Track tabs, the Tuning dialog and Properties | Nothing you need is missing; say whether Properties should stay a dialog or become a floating panel, whether the tuning should read low to high, and which button should be the default in the Tuning dialog |
| THE-216 | Click a beat while stopped, paused and playing; press Space in several places | Playback moves to the click; Space starts and pauses; say whether Space should pause in place or return to the start |
| THE-58 | Click marks on the fretboard and keyboard; switch handedness; restart the app | The beat is selected; the options are still set after a restart; the ring on a held note is readable at dock size |
| THE-75 | Press F1 in the main window and inside the Export dialog; search the help | The right topic opens, above the dialog; Escape closes the help first |

## Drums and plug-ins

| Ticket | Try | Passes when |
|---|---|---|
| THE-220 | On a drum track choose TAB, then standard + TAB; move with the arrow keys; print or export a PDF | Numbers sit on six lines, crash on top and kick at the bottom; Up and Down follow the lines; the print matches the screen |
| THE-218 | Put your drum library on a drum track; play, seek into a held cymbal, loop, export a range | It plays in time with the other tracks, nothing sticks or doubles, a held hit sounds after a seek, and the track sits where the score pans it |
| THE-218 | Put your amp plug-in on the second guitar | It sounds, on the side the score pans it to |
| THE-219 | Pick the preset of your library; export your library's own layout if you can | Every hit triggers the right piece; tell me which keys differ so the preset can be marked checked |

## Sound (also listed on THE-207)

| Ticket | Try | Passes when |
|---|---|---|
| THE-212 | Slow a backing track with bass to 50 % and 75 %; listen to a repeated low E | The bass keeps its level and does not flutter or dip around the attacks |
| THE-57 | Try the four metronome sounds; shift the key by a few semitones; set a fixed tempo with a backing track | The sounds are usable, the shifted key sounds right at the ends of the range, the backing follows without flutter |
| THE-57 | Export audio with "Include count-in" on (set count-in bars in the practice settings first) | The file starts with the count-in and the music follows on the beat |
| THE-60 | Play a score with a golpe | It sounds like a tap on the body |
| THE-70 | Route a track to a MIDI device; play chords into the score from a MIDI keyboard or guitar | Notes arrive in time and none hangs; played chords land on the right strings |

## Still only yours

- THE-207: the remaining listening and hardware checks listed on that ticket.
- THE-186: review the frozen source and write the admission for the three gated drivers (`docs/acceptance/admission-gated-drivers.md`).
- THE-59: drop a real file on the running app with unsaved work open.
- THE-61, THE-73, THE-76: a licensed Guitar Pro 8, real macOS and Linux machines, a native speaker for Estonian and German.
- THE-66, THE-72, THE-77, THE-74: the clipboard dependency, the licence and publication, the scope of the deferred rows, and the merge
  to `main`.
