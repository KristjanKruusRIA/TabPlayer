# THE-54: walk of the open-to-practise flow

Date: 2026-11-08. Branch `ux/the-54-practise-walk`, based on `develop` at 6556f78.

## Method and limits

- Real desktop test app built with `scripts/build-desktop-test.ps1` (`desktop-test` feature), driven over CDP on port 9223 with Playwright, using real mouse and keyboard input. Window 1440 by 900 for the main walk. 1280 by 800 and 960 by 600 were checked by emulating the viewport size over CDP; the native window was not resized, so the native minimum-size behaviour is not exercised.
- Score: the bundled CC0 Library example "Windowline" (6-string guitar, 4-string bass, drums, 8 bars). No private score.
- Persona: a bass player who opens the app for the first time, wants to learn bars 5 to 7, slow them down, loop them and fix one note.
- Screenshots were kept outside the repo (`E:\claude-tmp\the-54\`) and are not committed.
- Audio was running, but this walk judges the interface only. It does not judge sound, timing accuracy or how the app feels on a physical output device. Keyboard coverage is partial: Enter on Library rows, fret digits plus Enter, Escape on More playback, Stop. Tab order and screen-reader output were not walked.

## The walk

| # | Step | What I did | What I saw |
|---|------|------------|------------|
| 1 | Start | Launched the app. | A blank "Untitled" score behind a Library dialog with Recent, Templates, Folders, Examples and a "Welcome to TabPlayer" side note. Search has focus. Recent is empty on first run, so the first view is an empty list with "Open" at the bottom right. |
| 2 | Find a score | Clicked Examples, then double-clicked "Windowline". | Three examples, each with instruments and licence. Double-click only selected the row; the player had to find "Open example" at the bottom right (two more gestures than expected). The score opened in a new tab and the empty "Untitled" tab stayed beside it. Focus moved to the new document tab. |
| 3 | Pick a track | Chose "2. 4-string bass" in the track list in the position display. | One step. The score switched to bass notation and tablature, the display strip and overview highlighted the bass. Good. |
| 4 | Find the passage | Clicked a note in bar 5 and shift-clicked in bar 7. | Inspector says "Range selection M5-M7". On the score the range shows as two small green markers at its ends; the bars between are not shaded. The extent of the passage is hard to see. |
| 5 | Loop it | Looked for Loop. The toolbar has "1 - 1" fields and an icon. Opened More playback, then Selected playback, then pressed Loop selection. | Three nested gestures. The toolbar still showed 1 - 1 while the loop was 5 to 7, and the loop icon turned nearly invisible (dark ink on a dark button). The More playback panel stayed open over the top of the score. The loop range is not drawn on the score or the overview. |
| 6 | Slow down | Pressed Slower twice. | 100, 75, 50 percent in two clicks. The position display immediately shows 54 BPM. Good. There is no way to type a speed; steps are fixed presets. |
| 7 | Play | Pressed Play. | Playback started at bar 5, looped 5 to 7, the score scrolled to follow. Progress shows in the position display. Good. |
| 8 | Stop | Pressed Stop. | Back to bar 1 with the loop still armed (button dim, fields stale). |
| 9 | Small edit | Clicked a tab number in bar 6, pressed 7, then Enter; later in the rebuilt app also pressed Ctrl+Z. | Fret changed to 7, tab and notation redrawn, Undo enabled, tab shows an unsaved dot; Ctrl+Z restored the note and disabled Undo. Pressing 7 alone changed only the Inspector Fret field; the score did not change until Enter, with no hint on the score that an entry was pending. In the rebuilt app the edit also dropped the armed loop (the Loop button went back to unpressed), so the loop had to be pressed again. |
| 10 | Window sizes | Emulated 1280 by 800 and 960 by 600. | 1280: the Parchment page is wider than the score area, so bars 5 and later need horizontal scrolling until "Fit width" is pressed. 960: the "Visible tracks" label of the score display runs underneath the practice timer and view buttons. The score area is only about 240 px tall. |

## Friction, ranked by how much it hurts practice

1. **Looping a selected passage takes three nested gestures and then reports the wrong bars.** (Step 5.) The obvious controls, the bar fields and the Loop button, ignore the selection and, after a loop was set elsewhere, kept showing 1 - 1. A player who selects bars 5 to 7 and presses Loop gets bar 1. Fixed here (see Fixed).
2. **The running loop was nearly invisible.** (Steps 5 and 8.) The pressed Loop button used dark ink on its dark raised background. Fixed here.
3. **Loop range is not visible on the score or the overview.** Selection extent shows only as two end markers. A player cannot see where the loop starts and stops without reading the number fields. Split out.
4. **Loop controls are unlabelled icons and bare number boxes at normal widths.** The "Loop bars", "Click" and "Speed" captions are visually hidden below full HD, so "5 - 7 [icon]" has no visible meaning on first use. Tooltips were missing on the fields and the Loop button. Fixed with tooltips; visible captions split out.
5. **A Library row cannot be opened by double-click.** (Step 2.) Enter on a row already opened it. Fixed here.
6. **Opening a score leaves the empty "Untitled" tab behind.** (Step 2.) Every first-run example opening starts with a spare tab to close. Split out.
7. **At 1280 wide the score page is wider than the score area.** (Step 10.) The player must find "Fit width" to see a whole system. Split out.
8. **At 960 by 600 the toolbar leaves about 240 px for the score**, and the score display controls spilled over the view buttons. The overlap is fixed here, at the cost of one more toolbar row; the height problem is split out.
9. **Speed has presets only.** (Step 6.) No typed value, so a player cannot choose 60 percent. Split out.
10. **Fret entry gives no on-score hint while digits are pending.** (Step 9.) Split out.
11. **An edit drops the armed loop.** (Step 9.) Fixing a note while practising a loop clears the loop, because the playback plan is rebuilt after any score change. The bar fields now keep the loop's bars, so one press of Loop restores it, but the player should not have to. Split out.
12. **The section name "[Window] Window" overlaps the tempo mark at bar 1 of the example.** This is notation layout, not toolbar. Split out.

## Fixed

| Friction | Change | Test |
|----------|--------|------|
| 1 | The loop start and end fields now follow the selected bars (or the cursor's bar), so one press of Loop repeats what is selected. While a loop runs, the fields show that loop's bars however it was set (including Loop selection), and keep showing it while the selection moves. `src/Transport.tsx`. | `src/Transport.test.tsx`: "the loop bar fields follow the selected bars..." and "the loop bar fields show the loop that is running..." |
| 2 | `.transport-loopbutton[aria-pressed=true]` now uses the accent background with its ink colour. `src/workstation/gp-shell.css`. | CSS only; checked in the real app (before and after below). |
| 4 | Loop start and end fields carry their name as a tooltip, and the Loop button's tooltip reads "Loop bars 5 to 7" (new text `transport.loop_range_hint` in en, et, de). | Same Transport tests. |
| 5 | Double-clicking a Library row opens it, the same way Enter on the focused row does, once. `src/library/LibraryDialog.tsx`. | `src/library/LibraryDialog.test.tsx`: "double-clicking a row opens it once, as Enter does". |
| 8 (overlap only) | Below 1100 px the score display controls get a row of their own. `src/workstation/gp-shell.css`. | CSS only; checked at 960 by 600 in the real app. |

## After state (re-walked in a rebuilt app)

- Step 2: double-clicking "Windowline" opened it directly; the Library closed and the new tab was focused.
- Step 4 and 5: selecting M5 to M7 set the toolbar fields to 5 and 7 with no other action. The Loop button's tooltip said "Loop bars 5 to 7". One press of Loop armed the loop; the fields stayed 5 and 7 and Play started in bar 5.
- Step 5 (before and after the Loop button): the pressed button is now a solid accent with a light icon, clearly distinct from the unpressed one.
- Step 10: at 960 by 600 the score display controls sit on their own row, nothing overlaps. The score area is smaller than before (about 210 px tall) because that row now takes vertical space. That trade is recorded under Split out.
- Final build: the pressed Loop button read as a solid accent (rgb 111, 168, 255) with dark ink once its transition ended; it is a plain accent button next to the unpressed metronome. At 960 by 600 the display row no longer overlaps the view buttons. An edit and Ctrl+Z still work, and the edit drops the loop (friction 11).
- Not re-checked after the fixes: Tab order, the templates and Folders sections of the Library (double-click applies to their rows too, and is covered only by the example-row test), and the other two example scores.

## Split out

- **Show the selection and the loop on the score and the overview.** A range selection draws only two end markers, and an armed loop draws nothing on the score or the overview ruler. Shade the bars of the selected passage in the score and mark the loop range on the overview strip and the position display, so a player can see what will repeat without reading number fields. Touches ScoreView selection drawing and the overview component.
- **One-gesture "loop this selection" and a shortcut.** The exact-passage loop (Loop selection) is still inside More playback, Selected playback. Offer it next to the Loop button when a passage is selected, close More playback after it runs, and give Loop and Slower/Faster keyboard shortcuts so a player can stay on the score. Needs a decision on how it relates to the whole-bar Loop button, and keyboard shortcut allocation.
- **Visible captions for Loop, Click and Speed in the toolbar.** Below full HD the captions are visually hidden, leaving icons and bare numbers. Decide on a compact visible label or a first-use hint without costing toolbar width. This is a design decision as well as CSS.
- **Replace an untouched blank "Untitled" document when opening a score.** The first-run flow always leaves a spare empty tab. Needs a workspace rule (the blank document has no edits, has never been saved and is not the only tab) and a decision about whether it applies to opening files from outside the Library as well.
- **Default fit of the score to the window.** At 1280 wide and below the Parchment page needs horizontal scrolling until "Fit width" is pressed. Consider fitting to width by default, or when the score area is narrower than the page, and how that relates to the saved view defaults.
- **Make better use of height at 960 by 600.** The transport, the score display row and the editing palette leave about 210 to 240 px for the score. Consider folding the score display controls into one menu or button at small heights, and collapsing the inspector and overview by default in small windows.
- **Typed practice speed.** Offer a speed field next to Slower and Faster (for example 60 percent), keeping the preset steps and the fixed-tempo restriction, with undo semantics unchanged as speed is a session control.
- **Pending fret entry feedback.** While fret digits are typed and not committed with Enter, show the pending digits on the selected note or in the status line, and say that Enter commits and Escape cancels.
- **Keep the loop through an edit.** Any score change rebuilds the native playback plan, which clears the loop. While a loop is armed, re-apply it after the plan is rebuilt, and say so in the transport message if it cannot be restored. Touches NativePlaybackController generation handling; needs care with repeats and edits that change bar count.
- **Section label overlapping the tempo mark in the "Windowline" example at bar 1.** An alphaTab layout collision in the first system; check whether the engraving layer can separate directions and section text.
